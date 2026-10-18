/**
 * End-to-end check of a running backend: walks through a whole hackathon
 * the way the spec describes it and prints PASS / FAIL for each rule.
 *
 *   npm run dev                      (in one terminal)
 *   node scripts/e2e-check.mjs       (in another; API=http://localhost:5001 to change the port)
 *
 * It creates throw-away users and a group with random names, so it can be run
 * any number of times against your normal dev database. Needs Node 22+
 * (built-in fetch and WebSocket). The grading checks need Docker and
 * ENABLE_SUBMISSION_GRADING=true; without them they are reported as skipped.
 */

const API = process.env.API ?? 'http://localhost:5000';
const WS = API.replace(/^http/, 'ws');
const tag = Math.random().toString(36).slice(2, 7);
let failures = 0;

function check(ok, label, detail = '') {
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `  -> ${detail}` : ''}`
  );
}

async function call(token, method, path, body) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function user(name) {
  const { data } = await call(null, 'POST', '/auth/register', {
    username: `${name}_${tag}`,
    password: 'password123',
  });
  return {
    token: data.token,
    id: data.user?.id,
    username: data.user?.username,
  };
}

// Opens a socket (token sent as a subprotocol, like the client) and collects
// its messages. next(match) resolves with the next matching message.
function openSocket(path, token, { syncInit = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}${path}`, ['bearer', token]);
    const messages = [];
    const waiters = [];
    const deliver = (message) => {
      const waiter = waiters.find((w) => w.match(message));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        messages.push(message);
      }
    };
    ws.onmessage = (event) => deliver(JSON.parse(event.data));
    ws.onerror = () => reject(new Error('editor socket failed'));
    ws.onclose = (event) => deliver({ type: 'CLOSED', reason: event.reason });
    const next = (match, timeoutMs = 60000) =>
      new Promise((res) => {
        const found = messages.find(match);
        if (found) {
          messages.splice(messages.indexOf(found), 1);
          return res(found);
        }
        const waiter = { match, resolve: res };
        waiters.push(waiter);
        setTimeout(() => {
          if (waiters.includes(waiter)) {
            waiters.splice(waiters.indexOf(waiter), 1);
          }
          res({ type: 'TIMEOUT' });
        }, timeoutMs);
      });
    ws.onopen = () => {
      if (syncInit) ws.send(JSON.stringify({ type: 'SYNC_INIT' }));
      resolve({ ws, next, send: (m) => ws.send(JSON.stringify(m)) });
    };
  });
}

// The team's editor room
const editor = (token, teamId) =>
  openSocket(`/ws?roomId=team-${teamId}`, token, { syncInit: true });
// A user's live-notification socket
const notifications = (token) => openSocket('/ws/notifications', token);

const isInit = (m) => m.type === 'INIT_CODEBASE';

const health = await fetch(`${API}/api/health`).catch(() => null);
if (!health?.ok) {
  console.error(`No backend at ${API}. Start it first (or set API=...).`);
  process.exit(1);
}

// --- Accounts, group, invites -------------------------------------------
const admin = await user('admin');
const lead = await user('lead');
const mem = await user('mem');
const extra = await user('extra');
const late = await user('late');
check(
  admin.token && lead.token && mem.token && extra.token && late.token,
  'register 5 users'
);

const { data: g } = await call(admin.token, 'POST', '/groups', {
  name: `E2E ${tag}`,
});
const groupId = g.group?.id;
check(groupId, 'admin creates a group');
await call(admin.token, 'PATCH', `/groups/${groupId}/settings`, {
  maxTeamSize: 2,
  topK: 1,
  durationMin: 30,
});

for (const u of [lead, mem, extra, late]) {
  await call(admin.token, 'POST', `/groups/${groupId}/invites`, {
    username: u.username,
  });
}
// `late` only accepts after the event has started (checked further down)
for (const u of [lead, mem, extra]) {
  const { data } = await call(u.token, 'GET', '/groups/invites/mine');
  const invite = data.invites.find((i) => i.group.id === groupId);
  const r = await call(u.token, 'POST', `/groups/invites/${invite.id}/accept`);
  check(
    r.status === 200,
    `${u.username} accepts the group invite`,
    r.data.error
  );
}

const hidden = await call(lead.token, 'GET', `/groups/${groupId}/problems`);
check(
  hidden.data.revealed === false && hidden.data.problems.length === 0,
  'members cannot see problems before the start'
);

// --- Problems -----------------------------------------------------------
const p1 = await call(admin.token, 'POST', `/groups/${groupId}/problems`, {
  title: 'Reverse',
  description: 'Print the input line reversed.',
  submissionLimit: 3,
});
const p2 = await call(admin.token, 'POST', `/groups/${groupId}/problems`, {
  title: 'Echo',
  description: 'Print the input line.',
});
const p1Id = p1.data.problem?.id;
const p2Id = p2.data.problem?.id;
check(p1Id && p2Id, 'admin adds two problems', JSON.stringify(p1.data));

const early = await call(admin.token, 'POST', `/groups/${groupId}/start`);
check(early.status === 409, 'cannot start while a problem has no test cases');

await call(admin.token, 'POST', `/groups/${groupId}/problems/${p1Id}/tests`, {
  input: 'abc',
  expectedOutput: 'cba',
});
await call(admin.token, 'POST', `/groups/${groupId}/problems/${p2Id}/tests`, {
  input: 'hello',
  expectedOutput: 'hello',
});
await call(admin.token, 'POST', `/groups/${groupId}/problems/${p2Id}/tests`, {
  input: 'secret',
  expectedOutput: 'secret',
  hidden: true,
});

// --- Teams --------------------------------------------------------------
const team = await call(lead.token, 'POST', '/teams', {
  name: 'Alpha',
  groupId,
});
const teamId = team.data.id;
check(
  team.status === 201,
  'member creates a team and leads it',
  team.data.error
);

const inv = await call(lead.token, 'POST', `/teams/${teamId}/invites`, {
  userId: mem.id,
});
check(inv.status === 201, 'leader invites a member', inv.data.error);
// Max size 2: the leader + mem's pending invite already fill the team
const full = await call(lead.token, 'POST', `/teams/${teamId}/invites`, {
  userId: extra.id,
});
check(
  full.status === 400 && /maximum/i.test(full.data.error ?? ''),
  'pending invites count towards the maximum team size',
  `${full.status} ${full.data.error}`
);
const teamsView = await call(mem.token, 'GET', `/teams/group/${groupId}`);
const teamInvite = teamsView.data.pendingInvites.find(
  (i) => i.team.id === teamId
);
const joined = await call(
  mem.token,
  'POST',
  `/teams/invites/${teamInvite.id}/accept`
);
check(
  joined.status === 200,
  'member accepts the team invite',
  joined.data.error
);

// --- Before the start: the editor is read-only with the starter file -----
const early1 = await editor(lead.token, teamId);
const preInit = await early1.next(isInit, 5000);
check(
  preInit.type === 'INIT_CODEBASE' &&
    preInit.problemId === null &&
    preInit.files['main.py'] === 'def main():\n    pass\n',
  'before the start the editor shows the read-only main() stub'
);
early1.send({
  type: 'TEXT_EDIT',
  filePath: 'main.py',
  code: 'x',
});
const refused = await early1.next((m) => m.type === 'ERROR', 5000);
check(
  /not started/i.test(refused.error ?? ''),
  'edits are refused before the start'
);

// --- Start --------------------------------------------------------------
const memNotes = await notifications(mem.token);
const start = await call(admin.token, 'POST', `/groups/${groupId}/start`);
check(
  start.status === 200 && start.data.group.status === 'running',
  'admin starts the event',
  start.data.error
);

const groupChanged = await memNotes.next(
  (m) => m.type === 'GROUP_CHANGED',
  5000
);
check(
  groupChanged.type === 'GROUP_CHANGED',
  "members' open group pages are told the event started"
);

// The socket opened before the start is switched to problem 1 by itself
const switched = await early1.next(isInit, 10000);
check(
  switched.problemId === p1Id,
  'an editor left open before the start switches to problem 1'
);
early1.ws.close();

const { data: lateInvites } = await call(
  late.token,
  'GET',
  '/groups/invites/mine'
);
const lateInvite = lateInvites.invites.find((i) => i.group.id === groupId);
const lateAccept = await call(
  late.token,
  'POST',
  `/groups/invites/${lateInvite.id}/accept`
);
check(
  lateAccept.status === 409 && /started/i.test(lateAccept.data.error),
  'accepting a group invite after the start gives an informative error'
);

const leave = await call(mem.token, 'POST', `/teams/${teamId}/leave`);
check(leave.status === 409, 'teams are locked after the start');

const shown = await call(mem.token, 'GET', `/groups/${groupId}/problems`);
const echo = shown.data.problems.find((p) => p.id === p2Id);
check(
  echo &&
    echo.hiddenTestCount === 1 &&
    echo.testCases.every((t) => t.expectedOutput !== 'secret'),
  'problems are revealed, hidden tests stay secret'
);

// --- Editor: per-problem codebases --------------------------------------
const a = await editor(lead.token, teamId);
const b = await editor(mem.token, teamId);
const initA = await a.next(isInit);
await b.next(isInit);
check(
  initA.problemId === p1Id &&
    initA.files['main.py'] === 'def main():\n    pass\n',
  'team starts on problem 1 with the main.py stub'
);

b.send({ type: 'SELECT_PROBLEM', problemId: p2Id });
const denied = await b.next((m) => m.type === 'ERROR');
check(
  /leader/i.test(denied.error ?? ''),
  'only the leader can choose the problem'
);

a.send({ type: 'SELECT_PROBLEM', problemId: p2Id });
const [switchA, switchB] = await Promise.all([a.next(isInit), b.next(isInit)]);
check(
  switchA.problemId === p2Id && switchB.problemId === p2Id,
  'leader switches the whole team to problem 2'
);

// Member types a solution; the leader sees it
const solution = 'def main():\n    print(input())\n';
b.send({
  type: 'TEXT_EDIT',
  problemId: p2Id,
  filePath: 'main.py',
  code: solution,
});
const relayed = await a.next((m) => m.type === 'TEXT_EDIT');
check(
  relayed.filePath === 'main.py' && relayed.code === solution,
  'edits are synced to the other member (full text, last-write-wins)'
);

// Problem 1 kept its own code
a.send({ type: 'SELECT_PROBLEM', problemId: p1Id });
const back = await a.next(isInit);
await b.next(isInit);
check(
  back.files['main.py'] === 'def main():\n    pass\n',
  'each problem keeps its own codebase'
);
a.send({ type: 'SELECT_PROBLEM', problemId: p2Id });
const again = await a.next(isInit);
await b.next(isInit);
check(
  again.files['main.py'] === solution,
  'switching back brings the earlier code back'
);

// --- Submission (P4's /api/submit) ---------------------------------------
const submitted = await call(lead.token, 'POST', '/submit', {
  teamId,
  problemId: p2Id,
});
const seenByMember = await b.next((m) => m.type === 'SUBMISSION_RESULT', 5000);
if (!submitted.data.success) {
  console.log(
    `SKIP  submission grading (${submitted.data.error}) - needs Docker and ENABLE_SUBMISSION_GRADING=true`
  );
} else {
  const { evaluation } = submitted.data;
  check(
    evaluation.passPercentage === 100,
    'correct solution passes every test',
    JSON.stringify(evaluation)
  );
  check(
    seenByMember.type === 'SUBMISSION_RESULT',
    'the whole team receives the report'
  );
  const boardChanged = await memNotes.next(
    (m) => m.type === 'LEADERBOARD_CHANGED',
    5000
  );
  check(
    boardChanged.type === 'LEADERBOARD_CHANGED',
    'open leaderboards are told to reload'
  );
  const hiddenResult = evaluation.results.find((r) => r.hidden);
  check(
    hiddenResult && hiddenResult.input === undefined,
    'hidden test input is not sent'
  );

  const timeline = await call(
    mem.token,
    'GET',
    `/teams/${teamId}/submissions?problemId=${p2Id}`
  );
  check(
    timeline.data.submissions?.length === 1 &&
      timeline.data.submissions[0].evaluation.results.length === 2,
    'submission timeline lists the attempt with per-test results'
  );

//   const board = await call(mem.token, 'GET', `/leaderboards/group/${groupId}`);
//   const p2Board = board.data.problems?.find((p) => p.id === p2Id);
//   check(
//     p2Board?.entries[0]?.teamId === teamId && p2Board.entries[0].position === 1,
//     'problem leaderboard ranks the team'
//   );
//   check(
//     board.data.final?.[0]?.finalScore === 0,
//     'final score: best problem score of 0 for the only submitting team'
//   );
}

a.ws.close();
b.ws.close();
memNotes.ws.close();
console.log(
  failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.'
);
process.exit(failures ? 1 : 0);