const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  let now = 0;
  let nextId = 100;
  let timerId = 0;
  let stored = {};
  let messageListener;
  let alarmListener;
  let removedListener;
  const timers = new Map();
  const created = [];
  const removed = [];
  const alarms = [];
  const chrome = {
    storage: { local: {
      get: async defaults => structuredClone({ ...defaults, ...stored }),
      set: async values => { stored = structuredClone({ ...stored, ...values }); }
    } },
    runtime: { onMessage: { addListener: fn => { messageListener = fn; } } },
    alarms: {
      clear: async () => true,
      create: async (name, options) => { alarms.push({ name, ...options }); },
      onAlarm: { addListener: fn => { alarmListener = fn; } }
    },
    tabs: {
      create: async options => {
        const tab = { id: nextId++, ...options, time: now };
        created.push(tab);
        return tab;
      },
      remove: async id => { removed.push(id); removedListener(id); },
      onRemoved: { addListener: fn => { removedListener = fn; } }
    }
  };
  const context = vm.createContext({
    chrome, Date: { now: () => now }, Math,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, time: now + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
  const flush = async () => {
    await vm.runInContext('stateOperations', context);
    await vm.runInContext('stateOperations', context);
  };
  return {
    created, removed, alarms,
    state: () => structuredClone(stored.decisionMakerRunState),
    message: (message, tabId = 1) => new Promise(resolve => messageListener(message, { tab: { id: tabId } }, resolve)),
    advance: async time => {
      now = time;
      for (const [id, timer] of [...timers]) {
        if (timer.time <= now) { timers.delete(id); timer.fn(); }
      }
      await flush();
    },
    alarm: async () => { alarmListener({ name: 'dmf-next-profile' }); await flush(); },
    flush
  };
}

const start = h => h.message({ type: 'START_SEARCH_RUN', domain: 'www.example.com', queries: ['owner', 'CEO', 'founder', 'director'] });
const results = (h, id, links) => h.message({ type: 'GOOGLE_RESULTS_READY', links }, id);

test('new tabs launch every 2–3 seconds while previous searches remain unfinished', async () => {
  const h = harness();
  await start(h);
  await h.advance(1999);
  assert.equal(h.created.length, 1);
  await h.advance(3000);
  await h.advance(6000);
  await h.advance(9000);
  assert.equal(h.created.length, 4);
  assert.ok(h.created[1].time >= 2000 && h.created[1].time <= 3000);
  assert.ok(h.created[2].time - h.created[1].time >= 2000 && h.created[2].time - h.created[1].time <= 3000);
  assert.ok(h.created[3].time - h.created[2].time >= 2000 && h.created[3].time - h.created[2].time <= 3000);
  assert.ok(h.created.every(tab => tab.active === true));
  assert.equal(h.state().searchTabIds.length, 4);
  assert.equal(h.removed.length, 0);
  assert.match(h.created[0].url, /example.com%20owner$/);
});

test('out-of-order concurrent results close their own tabs, dedupe, and wait for all queries', async () => {
  const h = harness();
  await start(h);
  const a = 'https://www.linkedin.com/in/alice/';
  const b = 'https://www.linkedin.com/in/bob/';
  await results(h, 100, [a]);
  assert.deepEqual(h.removed, [100]);
  assert.equal(h.state().phase, 'searching');
  await h.advance(3000);
  await h.advance(6000);
  await Promise.all([results(h, 102, [b]), results(h, 101, [a.toUpperCase()])]);
  await h.flush();
  assert.equal(h.state().profileLinks.length, 2);
  assert.equal(h.created.length, 3);
  await h.advance(9000);
  await results(h, 103, []);
  await h.flush();
  assert.equal(h.state().phase, 'opening-profiles');
  assert.equal(h.created.length, 5);
    assert.equal(h.created[4].active, false);
  assert.equal(h.removed.length, 4);
  assert.ok(h.alarms[0].when >= 16000 && h.alarms[0].when <= 21000);
  await h.alarm();
  assert.equal(h.created.length, 6);
  assert.equal(h.created[5].url, b);
  assert.equal(h.created[5].active, false);
  await h.alarm();
  assert.equal(h.state().running, false);
});

test('Stop cancels future launches and ignores late results', async () => {
  const h = harness();
  await start(h);
  await h.message({ type: 'STOP_SEARCH_RUN' });
  await h.advance(3000);
  assert.equal(h.created.length, 1);
  assert.equal((await results(h, 100, ['https://www.linkedin.com/in/alice/'])).accepted, false);
  assert.equal(h.state().phase, 'stopped');
});

test('verification retains its tab while further queries keep launching', async () => {
  const h = harness();
  await start(h);
  await h.message({ type: 'GOOGLE_RESULTS_READY', verificationRequired: true }, 100);
  await h.advance(3000);
  assert.equal(h.created.length, 2);
  assert.equal(h.removed.length, 0);
  assert.deepEqual(h.state().verificationTabs, [100]);
});

test('LinkedIn mode appends linkedin and focuses each newly launched search tab', async () => {
  const h = harness();
  await h.message({ type: 'START_SEARCH_RUN', domain: 'example.com', queries: ['owner'], linkedIn: true });
  assert.equal(h.created[0].active, true);
  assert.match(h.created[0].url, /example.com%20owner%20linkedin$/);
});
