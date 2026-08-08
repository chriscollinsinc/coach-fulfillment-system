/* Minimal Gmail SMTP sender — no dependencies, just node:tls.
 * Requires env vars GMAIL_USER (the Gmail address) and GMAIL_APP_PASSWORD
 * (a 16-character Google "app password", not the normal account password).
 */
'use strict';
const tls = require('node:tls');

function buildMessage({ user, to, subject, text, attachments }){
  if(!attachments || !attachments.length){
    return [
      `From: Coach Fulfillment System <${user}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text.replace(/^\./gm, '..'),
      '.',
    ].join('\r\n');
  }
  const boundary = 'cfs-boundary-' + Math.random().toString(36).slice(2);
  const parts = [
    `From: Coach Fulfillment System <${user}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '',
  ];
  for(const a of attachments){
    const b64 = a.content.toString('base64');
    const lines = b64.match(/.{1,76}/g) || [''];
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      ...lines,
      '',
    );
  }
  parts.push(`--${boundary}--`);
  // Dot-stuff per RFC 5321 — same `^.` /gm approach the plain-text path already used
  // (matches after both \n and \r\n, since base64 never contains '.' this only ever
  // touches the plain-text intro) — done BEFORE appending the final ".\r\n" terminator,
  // which must stay a bare single dot for the SMTP server to recognize end-of-DATA.
  const body = parts.join('\r\n').replace(/^\./gm, '..');
  return body + '\r\n.';
}

function sendMail({ to, subject, text, attachments }){
  return new Promise((resolve, reject) => {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if(!user || !pass) return reject(new Error('Email not configured (GMAIL_USER/GMAIL_APP_PASSWORD missing)'));

    const steps = [
      { cmd: null, expect: '220' },                 // server greeting
      { cmd: 'EHLO localhost', expect: '250' },
      { cmd: 'AUTH LOGIN', expect: '334' },
      { cmd: Buffer.from(user).toString('base64'), expect: '334' },
      { cmd: Buffer.from(pass).toString('base64'), expect: '235' },
      { cmd: `MAIL FROM:<${user}>`, expect: '250' },
      { cmd: `RCPT TO:<${to}>`, expect: '250' },
      { cmd: 'DATA', expect: '354' },
      { cmd: buildMessage({ user, to, subject, text, attachments }), expect: '250' },
      { cmd: 'QUIT', expect: '221' },
    ];
    let i = 0;
    let buf = '';
    let done = false;

    const socket = tls.connect({ host: 'smtp.gmail.com', port: 465 });

    function fail(err){ if(done) return; done = true; try{ socket.destroy(); }catch(e){} reject(err); }
    function finish(){ if(done) return; done = true; try{ socket.end(); }catch(e){} resolve(); }
    function sendNext(){
      if(i >= steps.length) return finish();
      const step = steps[i];
      if(step.cmd !== null) socket.write(step.cmd + '\r\n');
    }

    socket.setTimeout(20000, () => fail(new Error('SMTP timeout')));
    socket.on('error', fail);
    socket.on('data', d => {
      buf += d.toString('utf8');
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for(const line of lines){
        if(line.length < 4 || line[3] !== ' ') continue; // wait for final line of a multi-line reply
        const code = line.slice(0, 3);
        const step = steps[i];
        if(!step || !code.startsWith(step.expect)) return fail(new Error(`SMTP error at step ${i}: ${line}`));
        i++;
        sendNext();
      }
    });
  });
}

module.exports = { sendMail, buildMessage };
