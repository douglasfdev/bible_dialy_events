const form = document.querySelector('#lead');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const feedback = document.querySelector('#feedback');
  const button = form.querySelector('button');
  button.disabled = true;
  feedback.textContent = 'Preparando sua conversa…';
  try {
    const data = new FormData(form);
    const response = await fetch('/api/lead', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:data.get('name'),phone:String(data.get('phone')).trim(),email:data.get('email'),consent:data.get('consent') === 'on'})});
    if (!response.ok) throw new Error(response.status === 429 ? 'Aguarde um minuto antes de tentar novamente.' : 'As inscrições estão indisponíveis agora. Tente novamente mais tarde.');
    const result = await response.json();
    const url = new URL(result.whatsappUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'wa.me') throw new Error('Não foi possível abrir o WhatsApp.');
    window.location.assign(url.href);
  } catch (error) { feedback.textContent = error.message || 'Não foi possível concluir.'; }
  finally { button.disabled = false; }
});
