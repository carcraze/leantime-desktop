'use strict';

const form = document.getElementById('setup-form');
const paneSelf = document.getElementById('pane-self');
const paneCloud = document.getElementById('pane-cloud');
const inputSelf = document.getElementById('server-url');
const inputCloud = document.getElementById('workspace');
const message = document.getElementById('message');
const btnTest = document.getElementById('test');
const btnSubmit = document.getElementById('submit');
const pricingLink = document.getElementById('pricing-link');

const modeInputs = Array.from(document.querySelectorAll('input[name="mode"]'));

function currentMode() {
  return modeInputs.find((r) => r.checked)?.value || 'self';
}

/** The active input for the selected mode. */
function activeInput() {
  return currentMode() === 'cloud' ? inputCloud : inputSelf;
}

/** Builds the URL to submit from whichever pane is active. */
function composeUrl() {
  if (currentMode() === 'cloud') {
    // Accept a bare workspace name, or paste-through of a full URL.
    const raw = inputCloud.value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!raw) return '';
    return /\./.test(raw) ? `https://${raw}` : `https://${raw}.leantime.io`;
  }
  return inputSelf.value.trim();
}

function setMessage(text, kind) {
  message.textContent = text || '';
  message.className = 'msg' + (text ? ` ${kind}` : '');
  const input = activeInput();
  if (kind === 'error' && text) {
    input.setAttribute('aria-invalid', 'true');
  } else {
    input.removeAttribute('aria-invalid');
  }
}

function clearMessage() {
  setMessage('', null);
}

function syncPanes() {
  const cloud = currentMode() === 'cloud';
  paneCloud.hidden = !cloud;
  paneSelf.hidden = cloud;
  clearMessage();
  activeInput().focus();
}

modeInputs.forEach((r) => r.addEventListener('change', syncPanes));
[inputSelf, inputCloud].forEach((i) => i.addEventListener('input', clearMessage));

// Sign-up information belongs in the user's real browser, not this window.
pricingLink.addEventListener('click', (event) => {
  event.preventDefault();
  window.open(pricingLink.href, '_blank');
});

function busy(on, label) {
  btnTest.disabled = on;
  btnSubmit.disabled = on;
  btnSubmit.textContent = on && label ? label : 'Connect';
  btnTest.textContent = on && !label ? 'Testing…' : 'Test connection';
}

btnTest.addEventListener('click', async () => {
  clearMessage();
  const url = composeUrl();
  if (!url) {
    setMessage(currentMode() === 'cloud'
      ? 'Enter your workspace name.'
      : 'Enter your Leantime server address.', 'error');
    return;
  }

  busy(true, null);
  try {
    const r = await window.leantimeSetup.testServer(url);
    if (r.ok) {
      setMessage(r.version
        ? `Found Leantime ${r.version} at ${r.url}.`
        : `Found a Leantime server at ${r.url}.`, 'ok');
    } else {
      setMessage(r.error, 'error');
    }
  } catch {
    setMessage('The connection test could not be completed.', 'error');
  } finally {
    busy(false);
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage();

  const url = composeUrl();
  if (!url) {
    setMessage(currentMode() === 'cloud'
      ? 'Enter your workspace name.'
      : 'Enter your Leantime server address.', 'error');
    activeInput().focus();
    return;
  }

  busy(true, 'Connecting…');
  try {
    // The main process re-verifies before saving, so an unreachable or
    // non-Leantime address is never persisted.
    const r = await window.leantimeSetup.setServer(url);
    if (!r.ok) {
      setMessage(r.error, 'error');
      activeInput().focus();
    }
  } catch {
    setMessage('Could not save the server address. Please try again.', 'error');
  } finally {
    busy(false);
  }
});

window.leantimeSetup.getConfig().then(({ serverUrl }) => {
  if (serverUrl) {
    const cloud = /^https:\/\/[^/]+\.leantime\.io$/i.test(serverUrl);
    if (cloud) {
      modeInputs.find((r) => r.value === 'cloud').checked = true;
      inputCloud.value = serverUrl.replace(/^https:\/\//i, '').replace(/\.leantime\.io$/i, '');
    } else {
      inputSelf.value = serverUrl;
    }
    syncPanes();
  } else {
    inputSelf.focus();
  }
});
