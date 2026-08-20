'use strict';

const form = document.getElementById('setup-form');
const input = document.getElementById('server-url');
const errorBox = document.getElementById('server-url-error');
const submit = document.getElementById('submit');

function showError(message) {
  errorBox.textContent = message;
  input.setAttribute('aria-invalid', 'true');
  input.focus();
}

function clearError() {
  errorBox.textContent = '';
  input.removeAttribute('aria-invalid');
}

window.leantimeSetup.getConfig().then(({ serverUrl }) => {
  if (serverUrl) {
    input.value = serverUrl;
  }
  input.focus();
  input.select();
});

input.addEventListener('input', clearError);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();

  submit.disabled = true;
  submit.textContent = 'Connecting…';

  try {
    const result = await window.leantimeSetup.setServer(input.value);
    if (!result.ok) {
      showError(result.error);
    }
  } catch {
    showError('Could not save the server address. Please try again.');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Connect';
  }
});
