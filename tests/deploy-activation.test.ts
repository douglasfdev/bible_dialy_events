import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
const workflow=readFileSync('.github/workflows/pipeline.yml','utf8');
function gate(value?:string) {
  const root=mkdtempSync(join(tmpdir(),'deploy-gate-'));const output=join(root,'output'),summary=join(root,'summary');
  writeFileSync(output,'');writeFileSync(summary,'');
  try {
    const result=spawnSync('bash',[resolve('scripts/resolve-deploy-gate.sh')],{encoding:'utf8',env:{...process.env,DEPLOY_ENABLED:value ?? '',GITHUB_OUTPUT:output,GITHUB_STEP_SUMMARY:summary}});
    return {...result,output:readFileSync(output,'utf8'),summary:readFileSync(summary,'utf8')};
  } finally {rmSync(root,{recursive:true,force:true});}
}
test('deploy enters production before resolving its environment secret, on main publication only',()=>{
  const deploy=workflow.split('\n  deploy:\n')[1]!;assert.ok(deploy);
  const header=deploy.split('    steps:')[0]!;
  assert.ok(!header.includes('ENABLE_ORACLE_DEPLOY'),'activation must not be resolved before environment injection');
  assert.match(header,/github\.event_name != 'pull_request'/);assert.match(header,/github\.ref == 'refs\/heads\/main'/);
  assert.match(header,/environment: production/);
  assert.match(deploy,/DEPLOY_ENABLED: \$\{\{ secrets\.ENABLE_ORACLE_DEPLOY \|\| vars\.ENABLE_ORACLE_DEPLOY \|\| 'false' \}\}/);
  for(const name of ['Configure verified SSH','Upload release and deploy'])
    assert.ok(deploy.includes(`- name: ${name}\n        if: steps.activation.outputs.deploy == 'enabled'`));
});
test('environment activation true enables SSH, including case and newline normalization',()=>{
  for(const value of ['true',' TRUE\r\n ']) { const result=gate(value);assert.equal(result.status,0,result.stderr);assert.equal(result.output,'deploy=enabled\n'); }
});
test('missing or false activation disables SSH with an explicit summary',()=>{
  for(const value of [undefined,'false']) { const result=gate(value);assert.equal(result.status,0,result.stderr);assert.equal(result.output,'deploy=disabled\n');assert.match(result.summary,/SSH não executado/); }
});
test('invalid activation fails with a useful error without exposing its value',()=>{
  const result=gate('sensitive-invalid-value');assert.equal(result.status,2);assert.match(result.stderr,/precisa conter true ou false/);
  assert.ok(!result.stderr.includes('sensitive-invalid-value'));assert.equal(result.output,'');
});
function sshConfig(overrides:Record<string,string>={}) {
  const root=mkdtempSync(join(tmpdir(),'deploy-ssh-'));const key=join(root,'test-key'),envFile=join(root,'environment');
  execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',key]);writeFileSync(envFile,'');
  const pub=readFileSync(`${key}.pub`,'utf8').trim();
  const step=workflow.split('      - name: Configure verified SSH\n')[1]!.split('\n      - name:')[0]!;
  const script=step.split('        run: |\n')[1]!.split('\n').map(line=>line.replace(/^          /,'')).join('\n');
  try {
    const result=spawnSync('bash',['-e','-o','pipefail','-c',script],{encoding:'utf8',env:{...process.env,
      RUNNER_TEMP:root,GITHUB_ENV:envFile,ORACLE_HOST:'oracle.example',ORACLE_USER:'ubuntu',ORACLE_SSH_PORT:'22',DEPLOY_PATH:'/opt/bible-daily-events',
      IMAGE_REF:`ghcr.io/example/app@sha256:${'a'.repeat(64)}`,
      SSH_PRIVATE_KEY:readFileSync(key,'utf8').replaceAll('\n','\r\n'),SSH_KNOWN_HOSTS:`oracle.example ${pub}\r\n`,...overrides}});
    return {...result,environment:readFileSync(envFile,'utf8')};
  } finally {rmSync(root,{recursive:true,force:true});}
}
test('SSH setup accepts a real private key with Windows line endings and exports validated settings',()=>{
  const result=sshConfig();assert.equal(result.status,0,result.stderr);assert.match(result.environment,/ORACLE_SSH_PORT=22/);assert.match(result.environment,/DEPLOY_PATH=\/opt\/bible-daily-events/);
});
test('SSH setup reports a missing host explicitly',()=>{
  const result=sshConfig({ORACLE_HOST:''});assert.equal(result.status,2);assert.match(result.stderr,/ORACLE_HOST ausente ou inválido/);
});
test('SSH setup rejects unrelated host keys and malformed private keys',()=>{
  let result=sshConfig({ORACLE_HOST:'other.example'});assert.equal(result.status,2);assert.match(result.stderr,/não contém a entrada do host\/porta/);
  result=sshConfig({SSH_PRIVATE_KEY:'not-a-private-key'});assert.equal(result.status,2);assert.match(result.stderr,/Chave privada SSH inválida/);
});
