/**
 * Regression test for real password-reset delivery.
 *
 * Resend refuses a sender whose domain is not verified. The reset flow must not
 * stop there: it retries once with Resend's shared test sender and reports which
 * sender actually carried the message. When even that is refused, the failure
 * must surface a real reason instead of a success.
 *
 * Runs offline: global.fetch is stubbed, so no email leaves this machine.
 */
import assert from 'node:assert/strict';

process.env.EMAIL_PROVIDER = 'resend';
process.env.RESEND_API_KEY = 'test-key-not-a-secret';
process.env.MAIL_FROM = 'WORKBRIDGE <no-reply@workbridges.live>';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.EMAIL_CAPTURE_DIR;

const UNVERIFIED =
  '{"statusCode":403,"message":"The workbridges.live domain is not verified. Please, add and verify your domain on https://resend.com/domains"}';
const OWNER_ONLY =
  '{"statusCode":403,"message":"You can only send testing emails to your own email address (owner@example.com). To send emails to other recipients, please verify a domain at resend.com/domains"}';

let checks = 0;
function check(label, condition) {
  checks += 1;
  assert.ok(condition, label);
  console.log(`  ok ${checks} - ${label}`);
}

const sent = [];
let responses = [];
global.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  sent.push(body);
  const next = responses.shift() || { ok: true, status: 200, body: '{"id":"msg_ok"}' };
  return {
    ok: next.ok,
    status: next.status,
    text: async () => next.body
  };
};

const { sendMail, getLastEmailAttempt } = await import('../server/email.js');

console.log('email delivery fallback');

// 1. Unverified sender domain -> retried with the shared Resend sender.
responses = [
  { ok: false, status: 403, body: UNVERIFIED },
  { ok: true, status: 200, body: '{"id":"msg_fallback"}' }
];
const first = await sendMail({
  to: 'worker@example.com',
  subject: 'Reset',
  text: 'link',
  html: '<p>link</p>'
});
check('uses the configured sender first', sent[0].from.includes('no-reply@workbridges.live'));
check('retries exactly once after the domain refusal', sent.length === 2);
check('retry uses the shared Resend test sender', sent[1].from.includes('onboarding@resend.dev'));
check('recipient is preserved on the retry', sent[1].to[0] === 'worker@example.com');
check('reports resend as the provider', first.provider === 'resend');
check('reports the sender that actually delivered', first.sender.includes('onboarding@resend.dev'));
check('flags the fallback sender', first.fallback_sender === true);
check('last attempt records a successful delivery', getLastEmailAttempt().ok === true);
check('last attempt names the real sender', getLastEmailAttempt().sender.includes('onboarding@resend.dev'));

// 2. Shared sender refused for a non-owner recipient -> real error, never success.
sent.length = 0;
responses = [
  { ok: false, status: 403, body: UNVERIFIED },
  { ok: false, status: 403, body: OWNER_ONLY }
];
let failure = null;
try {
  await sendMail({ to: 'someone@example.com', subject: 'Reset', text: 'link', html: '<p>link</p>' });
} catch (error) {
  failure = error;
}
check('a refused send throws instead of reporting success', failure !== null);
check('the error is identifiable', failure && failure.code === 'email_recipient_not_allowed');
check('the error explains the fix', /verify the sending domain/i.test(failure.message));
const attempt = getLastEmailAttempt();
check('last attempt records the failure', attempt.ok === false);
check('last attempt keeps the provider reason', /own email address/i.test(attempt.message));

// 3. A working sender must not retry at all.
sent.length = 0;
responses = [{ ok: true, status: 200, body: '{"id":"msg_direct"}' }];
const direct = await sendMail({
  to: 'worker@example.com',
  subject: 'Reset',
  text: 'link',
  html: '<p>link</p>'
});
check('a verified sender needs a single request', sent.length === 1);
check('no fallback is reported for a verified sender', direct.fallback_sender === false);
check('the configured sender is reported', direct.sender.includes('no-reply@workbridges.live'));

console.log(`\nemail fallback: ${checks} checks passed`);
