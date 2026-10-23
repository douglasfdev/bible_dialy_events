import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,readlinkSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const releaseId=`${'a'.repeat(40)}-1-1`;
const newImage=`ghcr.io/example/app@sha256:${'b'.repeat(64)}`;
const oldImage=`ghcr.io/example/app@sha256:${'c'.repeat(64)}`;
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'bible-deploy-'));
  const release=join(root,'releases',releaseId);const previous=join(root,'releases',`${'d'.repeat(40)}-2-1`);
  const bin=join(root,'bin');const shared=join(root,'shared');const log=join(root,'commands.log');
  for(const dir of [release,previous,bin,shared]) mkdirSync(dir,{recursive:true});
  for(const dir of [release,previous]) writeFileSync(join(dir,'docker-compose.yml'),'services: {}');
  writeFileSync(join(previous,'image.ref'),oldImage);symlinkSync(previous,join(root,'current'));
  writeFileSync(join(shared,'app.env'),'WHATSAPP_ENABLED=false\n');writeFileSync(join(shared,'compose.env'),'APP_DOMAIN=test.example\n');writeFileSync(join(shared,'event-sources.json'),'[]');
  // Mock only external Docker operations. Real shell, filesystem, lock and traps execute.
  writeFileSync(join(bin,'docker'),`#!/usr/bin/env bash
set -eu
printf '%s %s\\n' "\${APP_IMAGE:-none}" "$*" >> "$MOCK_LOG"
if [[ "$1" == login ]]; then cat >/dev/null; exit 0; fi
if [[ "$1" == volume ]]; then exit 0; fi
if [[ "$1" == run ]]; then
  name=snapshot.tgz
  for arg in "$@"; do
    if [[ "$arg" == BACKUP_NAME=* ]]; then name=\${arg#BACKUP_NAME=}; fi
    if [[ "$arg" == type=bind,source=*,target=/backup ]]; then
      dir=\${arg#type=bind,source=}; dir=\${dir%,target=/backup}; touch "$dir/$name"
    fi
  done
  exit 0
fi
if [[ "$1" == compose ]]; then
  args=" $* "
  if [[ "$args" == *' config --format json '* ]]; then echo '{"volumes":{"app_data":{"name":"mock-volume"}}}'; fi
  if [[ "$args" == *' up '* && "\${MOCK_FAIL_NEW:-false}" == true && "\${APP_IMAGE:-}" == "$MOCK_NEW_IMAGE" ]]; then exit 7; fi
fi
exit 0
`,{mode:0o700});
  return {root,release,previous,shared,log,run(fail=false){
    return spawnSync('bash',[resolve('deploy/remote-deploy.sh'),root,releaseId,newImage,'test-user'],{
      input:'dummy-test-token',encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,MOCK_LOG:log,MOCK_NEW_IMAGE:newImage,MOCK_FAIL_NEW:String(fail)},
    });
  },close(){rmSync(root,{recursive:true,force:true});}};
}
test('deploy script switches release only after health check and preserves a backup',()=>{
  const f=fixture();try {
    const result=f.run();assert.equal(result.status,0,result.stderr);
    assert.equal(readlinkSync(join(f.root,'current')),f.release);
    assert.equal(readFileSync(join(f.release,'image.ref'),'utf8').trim(),newImage);
    assert.ok(existsSync(join(f.shared,'backups',`${releaseId}.tgz`)));
    assert.ok(!readdirSync(f.release).some(name=>name.startsWith('.docker.')));
    const commands=readFileSync(f.log,'utf8');assert.ok(commands.indexOf(' stop app')<commands.indexOf(' run --rm'));
    assert.ok(commands.includes('exec -T app node'));assert.ok(!commands.includes('dummy-test-token'));
  } finally {f.close();}
});
test('failed deployment rolls back image, preserves current and exits with failure',()=>{
  const f=fixture();try {
    const result=f.run(true);assert.equal(result.status,7);
    assert.equal(readlinkSync(join(f.root,'current')),f.previous);
    assert.match(result.stderr,/Rollback da aplicação concluído/);
    const commands=readFileSync(f.log,'utf8');assert.ok(commands.split('\n').some(line=>line.startsWith(oldImage)&&line.includes(' up ')));
    assert.ok(existsSync(join(f.shared,'backups',`${releaseId}.tgz`)));
    assert.ok(!readdirSync(f.release).some(name=>name.startsWith('.docker.')));
  } finally {f.close();}
});
test('deployment refuses missing shared configuration before stopping application',()=>{
  const f=fixture();try {
    rmSync(join(f.shared,'app.env'));const result=f.run();assert.equal(result.status,2);
    assert.equal(readlinkSync(join(f.root,'current')),f.previous);assert.ok(!existsSync(f.log));
  } finally {f.close();}
});
