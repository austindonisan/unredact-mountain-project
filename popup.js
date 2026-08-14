'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;

function send(msg) {
  return new Promise((resolve) => {
    const maybe = api.runtime.sendMessage(msg, (resp) => {
      void api.runtime.lastError;
      resolve(resp);
    });
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, () => resolve(null));
  });
}

function get(defaults) {
  return new Promise((resolve) => {
    const maybe = api.storage.local.get(defaults, (v) => {
      void api.runtime.lastError;
      resolve(v || defaults);
    });
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, () => resolve(defaults));
  });
}

const $ = (id) => document.getElementById(id);

async function refresh() {
  const resp = await send({ cmd: 'stats' });
  if (!resp || !resp.ok) return;
  const s = resp.result;
  $('resolved').textContent = s.resolved;
  $('routes').textContent = s.routes;
  $('areas').textContent = s.areas;
  $('misses').textContent = s.misses;
  $('dataVersion').textContent = s.dataVersion;
}

async function init() {
  const { enabled } = await get({ enabled: true });
  $('enabled').checked = enabled !== false;

  $('enabled').addEventListener('change', (e) => {
    api.storage.local.set({ enabled: e.target.checked });
    $('status').textContent = 'Reload the page to apply.';
  });

  $('clear').addEventListener('click', async () => {
    await send({ cmd: 'clear' });
    $('status').textContent = 'Cache cleared.';
    refresh();
  });

  refresh();
}

init();
