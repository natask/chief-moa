export const MoaLanding = (function (scope) {
  var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function initWaitlist(document, fetchImpl) {
    var form = document.getElementById('waitlistForm');
    var email = document.getElementById('waitlistEmail');
    var submit = document.getElementById('waitlistSubmit');
    var msg = document.getElementById('waitlistMsg');

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var value = (email.value || '').trim();
      msg.className = 'msg';
      if (!emailRe.test(value)) {
        msg.textContent = 'Enter a valid email address.';
        msg.classList.add('err');
        email.focus();
        return;
      }

      submit.disabled = true;
      var previousLabel = submit.textContent;
      submit.textContent = '…';
      try {
        var response = await fetchImpl('/api/waitlist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: value }),
        });
        var data = await response.json().catch(function () { return {}; });
        if (response.ok) {
          form.style.display = 'none';
          msg.textContent = data.message || 'You are on the list. Check your inbox.';
          msg.classList.add('ok');
        } else {
          msg.textContent = data.error || 'Something went wrong. Try again.';
          msg.classList.add('err');
          submit.disabled = false;
          submit.textContent = previousLabel;
        }
      } catch (error) {
        msg.textContent = 'Network error. Try again.';
        msg.classList.add('err');
        submit.disabled = false;
        submit.textContent = previousLabel;
      }
    });
  }

  function initFloatingAgent(document, schedule) {
    var root = document.getElementById('ag-root');
    var launcher = document.getElementById('ag-launcher');
    var transcript = document.getElementById('ag-transcript');
    if (!root || !launcher) return;

    launcher.addEventListener('click', function () {
      var open = root.classList.toggle('ag-open');
      launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    var beats = [
      { state: 'listening', text: 'Listening…' },
      { state: 'thinking', text: 'Working on it…' },
      { state: 'speaking', text: 'Done. Opened the report and pinged the team.' },
    ];
    var index = 0;
    function step() {
      var beat = beats[index % beats.length];
      root.classList.remove('ag-state-listening', 'ag-state-thinking', 'ag-state-speaking');
      root.classList.add('ag-state-' + beat.state);
      transcript.textContent = beat.text;
      index += 1;
      schedule(step, beat.state === 'speaking' ? 3400 : 2400);
    }
    step();
  }

  function init(document, fetchImpl, schedule) {
    initWaitlist(document, fetchImpl);
    initFloatingAgent(document, schedule);
  }

  scope.MoaLanding = Object.freeze({
    init: init,
    initFloatingAgent: initFloatingAgent,
    initWaitlist: initWaitlist,
  });
  scope.MoaLanding.init(scope.document, scope.fetch.bind(scope), scope.setTimeout.bind(scope));
  return scope.MoaLanding;
}(globalThis));
