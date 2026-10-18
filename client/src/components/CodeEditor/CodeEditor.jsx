import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-python.js';
import { useSearchParams } from '../../router.jsx';
import FileTree from '../FileTree/FileTree.jsx';
import ResponseArea from '../ResponseArea/ResponseArea.jsx';
import SubmissionTimeline from '../SubmissionTimeline/SubmissionTimeline.jsx';
import { api, getToken } from '../../api.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { getFilePathsById } from '../FileTree/fileTreeUtils.js';
import { INDENT, nextLineIndentation, shiftLines } from './indentation.js';
import { mergeText } from '../../../../server/lib/textMerge.js';
import { mapSelection } from './caretPosition.js';
import './CodeEditor.css';

// The file that is open when the editor first loads
const DEFAULT_FILE = 'main.py';

// Reconnect delays: start at 1s, double each failed attempt, cap at 15s
const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;
// Close codes after which reconnecting can't help: the server refused the room
// (1008), the sign-in expired (4001) or the user was removed from the team
// (4003). Any other close (network drop, server restart) is retried.
const NO_RECONNECT_CODES = new Set([1003, 1008, 4001, 4003]);

// Builds the WebSocket URL, defaulting to ws(s)://<current host>/ws.
function getWebSocketUrl(wsUrl, roomId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(wsUrl || `${protocol}//${window.location.host}/ws`);

  url.searchParams.set('roomId', roomId);
  return url.toString();
}

// Opens the socket. Browsers can't set headers on a WebSocket, so the session
// token is sent as a second subprotocol rather than in the URL, where it would
// be written to server and proxy logs.
function openEditorSocket(wsUrl, roomId) {
  return new WebSocket(getWebSocketUrl(wsUrl, roomId), [
    'bearer',
    getToken() ?? '',
  ]);
}

// One-line summary of a graded submission for the terminal panel
function getSubmissionSummary(result) {
  if (!result.success) return `Submission failed: ${result.error}`;
  const { passedTests, totalTests } = result.evaluation;
  return `Submission graded: ${passedTests}/${totalTests} tests passed. See the report below.`;
}

// Turns code into HTML with <span class="token ..."> around keywords, strings,
// comments and so on (Prism's Python grammar). Prism escapes the text itself,
// so the result is safe to insert as HTML. The trailing newline gives the
// highlighted copy the same final empty line the textarea shows.
function highlightPython(code) {
  return `${Prism.highlight(code, Prism.languages.python, 'python')}
`;
}

// What to tell the user while the code is read-only
const READ_ONLY_NOTICES = {
  'not-started':
    'The event has not started yet. You can look around, but the code is read-only until the admin starts it.',
  ended: 'The event has ended. The code is now read-only.',
};

// Formats a RUN_RESULTS message (one result per visible test case) as the text
// shown in the terminal panel
function getRunOutput(message) {
  if (message.error) return `Run failed: ${message.error}`;

  const results = message.results ?? [];
  if (results.length === 0) {
    return 'This problem has no visible test cases to run.';
  }

  const passed = results.filter((result) => result.passed).length;
  const blocks = results.map((result, index) => {
    const lines = [
      `Test ${index + 1}: ${result.passed ? 'PASSED' : 'FAILED'}`,
      `Input:\n${result.input || '(empty)'}`,
      `Expected output:\n${result.expectedOutput || '(empty)'}`,
      `Your output:\n${result.actualOutput || '(no output)'}`,
    ];
    if (!result.passed && result.reason) lines.push(`Reason: ${result.reason}`);
    if (result.stderr) lines.push(`stderr:\n${result.stderr}`);
    return lines.join('\n');
  });

  return [
    `--- RUN: ${passed} of ${results.length} visible tests passed ---`,
    ...blocks,
    'Hidden tests are only checked when you submit.',
  ].join('\n\n');
}

/**
 * Collaborative Python editor.
 *
 * Connects to the server over a WebSocket and keeps every open file in sync
 * with the other users in the same room, so several people can type in the
 * same file at the same time and see each other's changes live.
 *
 * How syncing works (LAST-WRITE-WINS; this replaced operational transform):
 *  - For each file we track `text` (what the user currently sees) and
 *    `pending`, the number of edits we sent that the server has not yet
 *    acknowledged with an ACK.
 *  - Typing updates `text` immediately and sends the file's FULL new text to
 *    the server (TEXT_EDIT { filePath, code }), which stores it as the file's
 *    contents and relays it to everyone else. There are no operations, no
 *    revision numbers and no merging: whoever's write reaches the server last
 *    replaces the file for the whole team.
 *  - A remote TEXT_EDIT carries the full text and simply replaces ours. The
 *    one exception: while `pending > 0` we ignore remote text. The server
 *    handles messages in order, so a remote write that arrives before our ACK
 *    was processed BEFORE ours and ours wins; dropping it keeps this client
 *    identical to the server. (Applying it would leave us showing the other
 *    user's text while the server holds ours.)
 *  - The caret keeps its numeric position (clamped to the new length) when
 *    remote text replaces the file; it is not smartly shifted any more.
 *
 * The file tree is shared the same way, but simpler: file/folder operations go
 * to the server, which applies them and sends the whole tree back to everyone.
 * When a tree update renames or moves a file, its sync state is carried over to
 * the new path; if the open file was deleted another file is shown.
 *
 * Props:
 *  - roomId:    room to join (falls back to ?roomId=, then the user's own room)
 *  - wsUrl:     optional override of the WebSocket URL
 */
export default function CodeEditor({ roomId, wsUrl }) {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [teams, setTeams] = useState([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [teamsLoading, setTeamsLoading] = useState(true);
  const [teamsError, setTeamsError] = useState('');

  const requestedRoomId = roomId || searchParams.get('roomId');

  const selectedTeam = teams.find((team) => String(team.id) === selectedTeamId);

  const activeRoomId = selectedTeam ? `team-${selectedTeam.id}` : null;

  useEffect(() => {
    let active = true;

    async function loadTeams() {
      setTeamsLoading(true);
      setTeamsError('');

      try {
        const response = await api('/my-teams');

        if (!active) return;

        const availableTeams = response.teams || [];
        setTeams(availableTeams);

        const requestedTeamId = /^team-([1-9]\d*)$/.exec(
          requestedRoomId || ''
        )?.[1];

        const matchingTeam = availableTeams.find(
          (team) => String(team.id) === requestedTeamId
        );

        setSelectedTeamId(
          matchingTeam
            ? String(matchingTeam.id)
            : availableTeams.length > 0
              ? String(availableTeams[0].id)
              : ''
        );
      } catch (error) {
        if (!active) return;

        setTeams([]);
        setSelectedTeamId('');
        setTeamsError(error.message || 'Could not load your teams.');
      } finally {
        if (active) setTeamsLoading(false);
      }
    }

    if (user?.id) {
      loadTeams();
    } else {
      setTeams([]);
      setSelectedTeamId('');
      setTeamsLoading(false);
    }

    return () => {
      active = false;
    };
  }, [user?.id, requestedRoomId]);

  // main.py is open as soon as the editor loads
  const [activeFilePath, setActiveFilePath] = useState(DEFAULT_FILE);
  const [code, setCode] = useState('');
  // The room's shared file tree (null until the server sends it)
  const [tree, setTree] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  // True while waiting to retry after the connection dropped
  const [isReconnecting, setIsReconnecting] = useState(false);
  // 'not-started' | 'running' | 'ended', as last reported by the server (null
  // until it has said). The code can only be changed while it is 'running'.
  const [eventStatus, setEventStatus] = useState(null);
  const [isReady, setIsReady] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState(
    'Connecting to the shared Python workspace...'
  );

  // Refs hold values that message handlers need to read the *latest* value of
  // without being re-created (or triggering renders) on every change.
  const textareaRef = useRef(null);
  const highlightRef = useRef(null);
  const socketRef = useRef(null);
  const activePathRef = useRef(activeFilePath);
  // filePath -> { text, pending } (see above)
  const filesRef = useRef(new Map());
  // The latest tree received, readable from message handlers
  const treeRef = useRef(null);
  // Caret/selection to restore after a remote edit re-renders the textarea
  const pendingSelectionRef = useRef(null);
  const requestCounterRef = useRef(0);
  // Problem whose codebase the room is showing (from INIT_CODEBASE)
  const problemIdRef = useRef(null);
  const [problems, setProblems] = useState([]);
  const [activeProblemId, setActiveProblemId] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // The report shown in the response area (latest result or a timeline item)
  const [shownSubmission, setShownSubmission] = useState(null);
  const [timeline, setTimeline] = useState({
    submissions: [],
    used: 0,
    submissionLimit: 0,
  });
  // Bumped after each submission so the timeline reloads
  const [timelineVersion, setTimelineVersion] = useState(0);

  const isLeader = Boolean(selectedTeam && selectedTeam.leaderId === user?.id);
  const activeProblem = problems.find(
    (problem) => problem.id === activeProblemId
  );
  const groupId = selectedTeam?.groupId;
  const teamId = selectedTeam?.id;

  // Shows a graded submission if it belongs to the problem on screen
  const showSubmissionResult = useCallback((problemId, result) => {
    setTerminalOutput(getSubmissionSummary(result));
    if (problemId === undefined || problemId === problemIdRef.current) {
      setShownSubmission(
        result.success
          ? { id: result.submissionId, evaluation: result.evaluation }
          : { error: result.error }
      );
    }
    setTimelineVersion((version) => version + 1);
  }, []);

  // The submission timeline of the current problem
  useEffect(() => {
    if (!teamId || !activeProblemId) {
      setTimeline({ submissions: [], used: 0, submissionLimit: 0 });
      return undefined;
    }
    let active = true;
    api(`/teams/${teamId}/submissions?problemId=${activeProblemId}`)
      .then((data) => active && setTimeline(data))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [teamId, activeProblemId, timelineVersion]);

  // A different problem has a different report
  useEffect(() => {
    setShownSubmission(null);
  }, [activeProblemId, teamId]);

  // Keep the ref in sync with state on every render
  activePathRef.current = activeFilePath;

  // Restore the caret after React has written a remote change to the textarea
  useLayoutEffect(() => {
    const selection = pendingSelectionRef.current;
    const textarea = textareaRef.current;
    if (selection && textarea) {
      pendingSelectionRef.current = null;
      if (document.activeElement === textarea) {
        textarea.setSelectionRange(selection.start, selection.end);
      }
    }
  }, [code]);

  // Sends a payload if the socket is open; returns whether it was sent
  const sendWsMessage = useCallback((payload) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(payload));
      return true;
    }
    setTerminalOutput(
      'Not connected. Reconnect before editing or running code.'
    );
    return false;
  }, []);

  // Sends the file's full current text to the server (last-write-wins: the
  // server just overwrites its copy with this). Every send is counted in
  // `pending` until the server's ACK comes back, see the ACK case below.
  const flushFile = useCallback(
    (filePath) => {
      const file = filesRef.current.get(filePath);
      if (!file || file.mergeRejected) return;
      if (
        sendWsMessage({
          type: 'TEXT_EDIT',
          problemId: problemIdRef.current,
          filePath,
          code: file.text,
          baseCode: file.serverText,
        })
      ) {
        file.sent ??= [];
        file.sent.push(file.text);
        file.pending += 1;
      }
    },
    [sendWsMessage]
  );

  // Replaces our whole record of a file with the server's version, and shows
  // it if it is the active file
  const resetFile = useCallback((filePath, text) => {
    filesRef.current.set(filePath, { text, serverText: text, pending: 0, sent: [] });
    if (filePath === activePathRef.current) {
      pendingSelectionRef.current = null;
      setCode(text);
      setIsReady(true);
      setIsFileLoading(false);
    }
  }, []);

  // Applies text written by another user: the file is replaced by their text
  const applyRemoteEdit = useCallback(
    (message) => {
      const file = filesRef.current.get(message.filePath);
      // Unknown file: fetch it instead
      if (!file) {
        sendWsMessage({ type: 'SELECT_FILE', filePath: message.filePath });
        return;
      }
      if (typeof message.code !== 'string') return;
      // We have a write the server has not acknowledged yet. The server handled
      // this remote write first and ours after it, so ours is the winner and
      // the remote text is already out of date. Ignore it (see the component comment).
      const previousServerText = file.serverText ?? file.text;
      const mergedText = mergeText(
        previousServerText,
        message.code,
        file.text
      );
      file.serverText = message.code;

      const isActive = message.filePath === activePathRef.current;
      const textarea = textareaRef.current;
      // Keep the caret where it was, but never past the end of the new text
      const selection =
        isActive && textarea
          ? {
              ...mapSelection(file.text, mergedText, {
                start: textarea.selectionStart,
                end: textarea.selectionEnd,
              }),
            }
          : null;

      file.text = mergedText;
      if (isActive) {
        pendingSelectionRef.current = selection;
        setCode(file.text);
      }
    },
    [sendWsMessage]
  );

  // Shows a file in the editor: straight away if we already hold it, otherwise
  // after requesting it. An empty path means no file is open.
  const showFile = useCallback(
    (filePath) => {
      activePathRef.current = filePath;
      setActiveFilePath(filePath);
      pendingSelectionRef.current = null;

      const file = filesRef.current.get(filePath);
      if (file) {
        setCode(file.text);
        setIsReady(true);
        setIsFileLoading(false);
        return;
      }
      setCode('');
      setIsReady(false);
      if (filePath) {
        setIsFileLoading(true);
        sendWsMessage({ type: 'SELECT_FILE', filePath });
      } else {
        setIsFileLoading(false);
      }
    },
    [sendWsMessage]
  );

  // Adopts a new tree from the server. Files are keyed by path, so a rename or
  // move would orphan their sync state: carry it across by node ID instead.
  const applyTreeUpdate = useCallback(
    (newTree) => {
      const oldPaths = treeRef.current
        ? getFilePathsById(treeRef.current)
        : new Map();
      const newPaths = getFilePathsById(newTree);
      treeRef.current = newTree;
      setTree(newTree);

      const carried = new Map();
      const resend = [];
      for (const [id, oldPath] of oldPaths) {
        const file = filesRef.current.get(oldPath);
        const newPath = newPaths.get(id);
        if (!file || !newPath) continue;

        // Edits still awaiting their ACK were sent to the old path, where the
        // server will not apply them (the file has moved). Forget them and,
        // after the loop, send the current text again to the new path.
        const hadPending = file.pending > 0;
        file.pending = 0;
        file.sent = [];

        // A rejected edit must remain available for manual recovery,
        // not be silently retried after a rename or move.
        if (hadPending && !file.mergeRejected) {
          resend.push(newPath);
        }
        carried.set(newPath, file);
      }
      filesRef.current = carried;
      for (const filePath of resend) flushFile(filePath);

      // Follow the open file if it moved; fall back to another if it is gone
      const activePath = activePathRef.current;
      const activeId = [...oldPaths].find(
        ([, path]) => path === activePath
      )?.[0];
      const nextPath = activeId ? newPaths.get(activeId) : undefined;
      if (nextPath === activePath) return;
      showFile(nextPath ?? newPaths.values().next().value ?? '');
    },
    [flushFile, showFile]
  );

  // Applies a message from the server to local state
  const handleIncomingMessage = useCallback(
    (message) => {
      switch (message.type) {
        // Full room state on connect: show the active file, or request it if
        // the room doesn't have it yet
        case 'INIT_CODEBASE': {
          // A different problemId means the leader switched, not a reconnect
          const switchedProblem =
            problemIdRef.current !== null &&
            message.problemId !== problemIdRef.current;
          problemIdRef.current = message.problemId ?? null;
          setActiveProblemId(message.problemId ?? null);
          // After a reconnect, anything typed that never reached the server is
          // replaced by the team's version; say so rather than lose it quietly
          const previousFiles = filesRef.current;
          const unsynced = [...previousFiles.values()].filter(
            (file) => file.pending > 0 && !file.mergeRejected
          ).length;
          const rejectedFiles = [...previousFiles.entries()].filter(
            ([, file]) => file.mergeRejected
          );
          if (unsynced > 0 && !switchedProblem) {
            setTerminalOutput(
              `Reconnected. ${unsynced} file${unsynced === 1 ? '' : 's'} had changes that could not be sent and were reset to the team's version.`
            );
          }
          filesRef.current = new Map();
          treeRef.current = message.tree;
          setTree(message.tree);
          for (const [filePath, text] of Object.entries(message.files || {})) {
            resetFile(filePath, text);
          }

          if (!switchedProblem && rejectedFiles.length > 0) {
            let preserved = 0;
            for (const [filePath, previous] of rejectedFiles) {
              const current = filesRef.current.get(filePath);
              if (!current) continue;

              current.text = previous.text;
              current.mergeRejected = true;
              current.pending = 0;
              current.sent = [];
              preserved++;

              if (filePath === activePathRef.current) {
                setCode(previous.text);
              }
            }

            if (preserved > 0) {
              setTerminalOutput(
                `${preserved} file${preserved === 1 ? '' : 's'} contain unsaved edits that could not be merged. Your text is preserved locally, but it has NOT been saved to the server. Copy it somewhere safe before refreshing.`
              );
            }
          }

          // Open main.py, or whatever file is first if it was deleted
          if (!filesRef.current.has(activePathRef.current)) {
            showFile(filesRef.current.keys().next().value ?? '');
          }
          break;
        }

        // The room's file tree changed (by us or another user)
        case 'TREE_UPDATE':
          applyTreeUpdate(message.tree);
          break;

        // Authoritative copy of one file (response to SELECT_FILE, or sent
        // when the server couldn't reconcile our edit) - overwrites local text
        case 'FILE_SNAPSHOT': {
          const existing = filesRef.current.get(message.filePath);

          if (existing?.mergeRejected) {
            // Keep unsaved local work visible instead of replacing it.
            // Store the authoritative version separately for recovery.
            existing.serverText = message.code;
            existing.pending = 0;
            existing.sent = [];
            // Keep recovery mode active until the user explicitly resolves
            // the unsaved text. Do not silently resume automatic saves.
            existing.mergeRejected = true;

            if (message.filePath === activePathRef.current) {
              setCode(existing.text);
              setIsReady(true);
              setIsFileLoading(false);
            }

            setTerminalOutput(
              'Your latest edit could not be saved. Your unsaved text is still in the editor. Copy it somewhere safe before refreshing or switching files.'
            );
          } else {
            resetFile(message.filePath, message.code);
          }
          break;
        }

        // Another user's write: the file's new full text
        case 'TEXT_EDIT':
          applyRemoteEdit(message);
          break;

        // The server applied one of our writes. When the count reaches zero
        // the server holds exactly what we show, so remote text is accepted again
        case 'ACK': {
          const file = filesRef.current.get(message.filePath);
          if (file) {
            const sentText = file.sent?.shift();
            file.pending = Math.max(0, file.pending - 1);

            if (typeof message.code === 'string') {
              const mergedText = mergeText(
                sentText ?? file.serverText ?? file.text,
                message.code,
                file.text
              );
              const isActive = message.filePath === activePathRef.current;
              const textarea = textareaRef.current;
              if (isActive && textarea && mergedText !== file.text) {
                pendingSelectionRef.current = mapSelection(
                  file.text,
                  mergedText,
                  {
                    start: textarea.selectionStart,
                    end: textarea.selectionEnd,
                  }
                );
              }

              file.serverText = message.code;
              file.text = mergedText;

              if (isActive) {
                setCode(mergedText);
              }

              // Only send a follow-up if there are no outstanding writes
              // and the merged local text differs from the server's version.
              // A microtask rechecks the latest state before sending.
              if (file.pending === 0 && mergedText !== message.code) {
                queueMicrotask(() => {
                  const latest = filesRef.current.get(message.filePath);
                  if (
                    latest === file &&
                    latest.pending === 0 &&
                    latest.text !== latest.serverText
                  ) {
                    flushFile(message.filePath);
                  }
                });
              }
            }
          }
          break;
        }

        // Output of a RUN_CODE request
        case 'RUN_RESULTS':
          setIsRunning(false);
          setTerminalOutput(getRunOutput(message));
          break;

        case 'SUBMISSION_UNAVAILABLE':
          setTerminalOutput(message.message);
          break;

        // The leader submitted; grading is running on the server
        case 'SUBMISSION_STARTED':
          setIsSubmitting(true);
          setTerminalOutput(
            `${message.username} submitted the code for grading. Running the tests...`
          );
          break;

        // The graded report, sent to everyone in the team
        case 'SUBMISSION_RESULT':
          setIsSubmitting(false);
          showSubmissionResult(message.problemId, message.result);
          break;

        // The event started or ended (also sent once on connecting)
        case 'EVENT_STATUS':
          setEventStatus(message.status);
          break;

        // A rejected edit is never ACKed, so it would leave `pending` above zero
        // and block remote text forever; drop our copy and fetch the server's
        case 'ERROR': {
          setTerminalOutput(`Editor error: ${message.error}`);
          setIsFileLoading(false);
          setIsRunning(false);
          const file = message.filePath
            ? filesRef.current.get(message.filePath)
            : null;
          if (file?.pending > 0) {
            // Do not discard local changes when the server rejects a write.
            file.mergeRejected = true;
            file.pending = 0;
            file.sent = [];
          }
          break;
        }

        default:
          break;
      }
    },
    [
      applyRemoteEdit,
      applyTreeUpdate,
      resetFile,
      showFile,
      showSubmissionResult,
    ]
  );

  // Open the socket when the room/problem/url changes and close it on cleanup.
  // If the connection drops (network blip, server restart) it is reopened with
  // a growing delay; the server then sends the room again from scratch.
  // `active` guards against callbacks firing after the effect was cleaned up.
  useEffect(() => {
    let active = true;
    let socket = null;
    let retryTimer = null;
    let retryDelay = MIN_RETRY_MS;

    // Start every room from a clean slate so nothing from the previous room
    // can be edited (and then lost) while the new one connects
    filesRef.current = new Map();
    treeRef.current = null;
    pendingSelectionRef.current = null;
    activePathRef.current = DEFAULT_FILE;
    setTree(null);
    setCode('');
    setActiveFilePath(DEFAULT_FILE);
    setIsConnected(false);
    setIsReconnecting(false);
    setEventStatus(null);
    problemIdRef.current = null;
    setActiveProblemId(null);
    setIsReady(false);
    setIsRunning(false);
    setIsFileLoading(false);

    if (!activeRoomId) {
      setIsConnected(false);
      socketRef.current = null;
      return undefined;
    }

    function connect() {
      try {
        socket = openEditorSocket(wsUrl, activeRoomId);
      } catch (error) {
        setTerminalOutput(`Could not connect to the editor: ${error.message}`);
        return;
      }
      const thisSocket = socket;
      socketRef.current = thisSocket;

      thisSocket.onopen = () => {
        if (!active) return;
        retryDelay = MIN_RETRY_MS;
        setIsConnected(true);
        setIsReconnecting(false);
        setTerminalOutput(`Connected to shared room: ${activeRoomId}`);
        thisSocket.send(JSON.stringify({ type: 'SYNC_INIT' }));
      };

      thisSocket.onmessage = (event) => {
        if (!active) return;
        try {
          handleIncomingMessage(JSON.parse(event.data));
        } catch (error) {
          console.error('Failed to process WebSocket message:', error);
          setTerminalOutput(
            'Received an invalid response from the editor server.'
          );
        }
      };

      thisSocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      thisSocket.onclose = (event) => {
        if (!active) return;
        setIsConnected(false);
        setIsReady(false);
        setIsRunning(false);

        if (event.code === 4001) {
          setTerminalOutput(
            'Your sign-in has expired. Sign in again to use the editor.'
          );
          window.dispatchEvent(new Event('auth:expired'));
          return;
        }
        if (NO_RECONNECT_CODES.has(event.code)) {
          setTerminalOutput(
            event.reason
              ? `Disconnected from the editor server: ${event.reason}`
              : 'Disconnected from the editor server.'
          );
          return;
        }

        // Anything else is probably temporary: try again shortly. The text is
        // read-only until then (isReady is false), so nothing is typed into a
        // connection that can't deliver it.
        setIsReconnecting(true);
        setTerminalOutput('Connection lost. Reconnecting...');
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
      };
    }

    connect();

    return () => {
      active = false;
      clearTimeout(retryTimer);
      socket?.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [activeRoomId, handleIncomingMessage, wsUrl]);

  useEffect(() => {
    if (!groupId) {
      setProblems([]);
      return undefined;
    }
    let active = true;
    api(`/groups/${groupId}/problems`)
      .then((data) => active && setProblems(data.problems ?? []))
      .catch(() => active && setProblems([]));
    return () => {
      active = false;
    };
  }, [groupId, eventStatus]);

  // Applies a local change immediately, then syncs it to the server.
  // `cursor` (a caret position, or a { start, end } selection) is restored
  // after React re-renders the textarea.
  const applyLocalEdit = (updatedCode, cursor) => {
    const filePath = activePathRef.current;
    const file = filesRef.current.get(filePath);
    if (!file) return;

    if (updatedCode === file.text) return;
    file.text = updatedCode;
    setCode(updatedCode);
    flushFile(filePath);

    // Restored by the layout effect once React has written the new text
    if (cursor !== undefined) {
      pendingSelectionRef.current =
        typeof cursor === 'number' ? { start: cursor, end: cursor } : cursor;
    }
  };

  // Normal typing / pasting / deleting
  const handleInput = (event) => {
    applyLocalEdit(event.target.value);
  };

  // Switches the active file. Files we already hold are shown straight away
  // (the server's broadcasts keep them live); others are requested first.
  const handleSelectFile = useCallback(
    (filePath) => {
      if (filePath === activePathRef.current) return;
      showFile(filePath);
    },
    [showFile]
  );

  // Asks the server to create/rename/delete/move a file or folder; the change
  // appears when the server's TREE_UPDATE comes back
  const handleTreeOperation = useCallback(
    (operation) => {
      sendWsMessage({
        type: 'TREE_OPERATION',
        problemId: problemIdRef.current,
        operation,
      });
    },
    [sendWsMessage]
  );

  // The highlighted copy sits behind the textarea; keep it scrolled to match
  const handleScroll = (event) => {
    const highlight = highlightRef.current;
    if (!highlight) return;
    highlight.scrollTop = event.target.scrollTop;
    highlight.scrollLeft = event.target.scrollLeft;
  };

  // Python-friendly editing behaviour: Tab inserts 4 spaces, Backspace removes
  // a whole indent level, and Enter keeps (or adds/removes) indentation.
  const handleKeyDown = (event) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const { selectionStart, selectionEnd, value } = textarea;

    // Tab -> indent instead of moving focus. With a selection (or Shift+Tab)
    // whole lines are indented/outdented, so selected text is never replaced.
    if (event.key === 'Tab') {
      event.preventDefault();
      if (event.shiftKey || selectionStart !== selectionEnd) {
        const shifted = shiftLines(
          value,
          selectionStart,
          selectionEnd,
          event.shiftKey
        );
        applyLocalEdit(shifted.value, {
          start: shifted.selectionStart,
          end: shifted.selectionEnd,
        });
        return;
      }
      const next =
        value.slice(0, selectionStart) + INDENT + value.slice(selectionEnd);
      applyLocalEdit(next, selectionStart + INDENT.length);
      return;
    }

    // Backspace with only an indent to the left of the cursor -> delete the
    // whole indent (4 spaces or one tab) rather than a single character
    if (
      event.key === 'Backspace' &&
      selectionStart === selectionEnd &&
      selectionStart > 0
    ) {
      const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
      const beforeCursor = value.slice(lineStart, selectionStart);
      if (/^(?: {4}|\t)$/.test(beforeCursor.slice(-4))) {
        event.preventDefault();
        const indentationLength = beforeCursor.endsWith('\t') ? 1 : 4;
        const next =
          value.slice(0, selectionStart - indentationLength) +
          value.slice(selectionEnd);
        applyLocalEdit(next, selectionStart - indentationLength);
        return;
      }
    }

    // Enter -> auto-indent: copy the current line's indentation, add a level
    // after a line ending in ':', and remove one after return/pass/break/...
    if (
      event.key !== 'Enter' ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();

    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const lineBeforeCursor = value.slice(lineStart, selectionStart);
    const inserted = `\n${nextLineIndentation(lineBeforeCursor)}`;
    const next =
      value.slice(0, selectionStart) + inserted + value.slice(selectionEnd);
    applyLocalEdit(next, selectionStart + inserted.length);
  };

  // Asks the server to run the team's code against the visible test cases;
  // the results arrive as RUN_RESULTS
  const handleRunCode = () => {
    const requestId = `run-${Date.now()}-${++requestCounterRef.current}`;
    if (
      sendWsMessage({
        type: 'RUN_CODE',
        requestId,
      })
    ) {
      setIsRunning(true);
      setTerminalOutput('Running the visible test cases...');
    }
  };

  // Leader only: grade the team's saved code for the current problem via
  // @Thando's POST /api/submit. The room also gets the result over the socket.
  const handleSubmit = async () => {
    const ok = window.confirm(
      `Submit the current code for "${activeProblem?.title ?? 'this problem'}"?`
    );
    if (!ok) return;
    const problemId = activeProblemId;
    setIsSubmitting(true);
    setTerminalOutput('Submitting...');
    try {
      const result = await api('/submit', {
        method: 'POST',
        body: { teamId, problemId },
      });
      showSubmissionResult(problemId, result);
    } catch (error) {
      showSubmissionResult(problemId, { success: false, error: error.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const attemptsLeft =
    timeline.submissionLimit > 0
      ? Math.max(0, timeline.submissionLimit - timeline.used)
      : null;

  // Leader only: switch the whole team to another problem
  const handleSelectProblem = (event) => {
    const problemId = Number(event.target.value);
    if (problemId && problemId !== problemIdRef.current) {
      sendWsMessage({ type: 'SELECT_PROBLEM', problemId });
    }
  };

  // The code can only be changed once the room is loaded and the event is on
  const isEditable = isReady && eventStatus === 'running';
  const readOnlyNotice =
    isConnected && eventStatus ? READ_ONLY_NOTICES[eventStatus] : null;

  // With no room there is no socket to report on, so say what is needed
  const statusText =
    activeRoomId || teamsLoading
      ? terminalOutput
      : teamsError
        ? 'Could not load your teams.'
        : 'You are not in a team yet. Create or join one on a group page to start coding.';

  return (
    <div className="editor page-enter">
      <header className="editor-header">
        <div className="editor-title">
          <p className="editor-brand">
            The Hackathon
            {selectedTeam?.group?.name ? `: ${selectedTeam.group.name}` : ''}
          </p>
          <div className="editor-status">
            <span
              className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}
              aria-hidden="true"
            />
            <span role="status">
              {isConnected
                ? 'Connected'
                : isReconnecting
                  ? 'Reconnecting...'
                  : 'Disconnected'}
            </span>
          </div>
          <div className="editor-room">
            <span className="editor-room-label">Room: </span>
            <span className="editor-room-value">
              {activeRoomId || 'No team selected'}
            </span>
          </div>
          <div className="editor-team-selector">
            <label htmlFor="editor-team-select">Team: </label>

            <select
              id="editor-team-select"
              className="editor-team-select"
              value={selectedTeamId}
              onChange={(event) => setSelectedTeamId(event.target.value)}
              disabled={teamsLoading || teams.length === 0}
              aria-label="Select collaboration team"
            >
              {teams.length === 0 && (
                <option value="">
                  {teamsLoading ? 'Loading teams...' : 'No teams available'}
                </option>
              )}

              {teams.map((team) => (
                <option key={team.id} value={String(team.id)}>
                  {team.name}
                </option>
              ))}
            </select>

            {teamsError && (
              <p role="alert" className="editor-team-error">
                {teamsError}
              </p>
            )}
          </div>
        </div>

        <div className="editor-actions">
          <button
            className="editor-btn editor-btn-primary"
            type="button"
            onClick={handleRunCode}
            disabled={!isEditable || isRunning || isFileLoading}
          >
            {isRunning ? 'Running...' : 'Run Python'}
          </button>
          {isLeader ? (
            <button
              className="editor-btn"
              type="button"
              onClick={handleSubmit}
              disabled={
                !isReady ||
                isSubmitting ||
                eventStatus !== 'running' ||
                !activeProblemId ||
                attemptsLeft === 0
              }
            >
              {isSubmitting ? 'Grading...' : 'Submit solution'}
            </button>
          ) : (
            selectedTeam && (
              <span className="editor-hint">
                Only the team leader can submit.
              </span>
            )
          )}
        </div>
      </header>

      {readOnlyNotice && (
        <p className="editor-notice" role="status">
          {readOnlyNotice}
        </p>
      )}

      {activeRoomId && eventStatus && eventStatus !== 'not-started' && (
        <section className="editor-problem" aria-label="Current problem">
          <div className="editor-problem-bar">
            <label htmlFor="editor-problem-select">Problem: </label>
            <select
              id="editor-problem-select"
              className="editor-team-select"
              value={activeProblemId ?? ''}
              onChange={handleSelectProblem}
              disabled={!isLeader || !isConnected || problems.length === 0}
            >
              {!activeProblem && <option value="">—</option>}
              {problems.map((problem) => (
                <option key={problem.id} value={problem.id}>
                  {problem.orderIndex + 1}. {problem.title}
                </option>
              ))}
            </select>
            <span className="editor-hint">
              {isLeader
                ? 'You choose the problem for the whole team.'
                : 'The team leader chooses the problem.'}
              {attemptsLeft !== null &&
                ` ${attemptsLeft} of ${timeline.submissionLimit} attempts left.`}
            </span>
          </div>

          {activeProblem && (
            <div className="editor-problem-details">
              <h2 className="editor-problem-title">{activeProblem.title}</h2>
              <p className="editor-problem-text">{activeProblem.description}</p>
              {(activeProblem.inputFormat || activeProblem.outputFormat) && (
                <dl className="editor-problem-formats">
                  {activeProblem.inputFormat && (
                    <div>
                      <dt>Input</dt>
                      <dd>{activeProblem.inputFormat}</dd>
                    </div>
                  )}
                  {activeProblem.outputFormat && (
                    <div>
                      <dt>Output</dt>
                      <dd>{activeProblem.outputFormat}</dd>
                    </div>
                  )}
                </dl>
              )}
              <p className="editor-hint">
                Your main.py is run and its main() function is called. Read
                input with input() and print the answer.
              </p>
            </div>
          )}
        </section>
      )}

      <div className="editor-body">
        <aside className="editor-sidebar">
          {activeRoomId || teamsLoading ? (
            <FileTree
              tree={tree}
              onOperation={handleTreeOperation}
              onSelectFile={handleSelectFile}
              selectedPath={activeFilePath}
              readOnly={eventStatus !== 'running'}
            />
          ) : (
            <p className="editor-no-team">No team selected.</p>
          )}
        </aside>

        <main className="editor-workspace">
          <div className="active-tab">{activeFilePath || 'No file open'}</div>
          {/* Syntax highlighting: a coloured copy of the code is drawn in a
              <pre> behind a textarea whose own text is transparent, so typing,
              selection and the caret all still come from the real textarea */}
          <div className="code-editor-area">
            <pre
              ref={highlightRef}
              className="code-highlight"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: highlightPython(code) }}
            />
            <textarea
              ref={textareaRef}
              value={code}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onScroll={handleScroll}
              placeholder="Write Python code here..."
              spellCheck={false}
              wrap="off"
              className="code-input"
              aria-label={`Python source code in ${activeFilePath}`}
              disabled={!isReady || isFileLoading}
              readOnly={!isEditable}
            />
          </div>
          <section className="terminal-panel" aria-label="Execution output">
            <div className="terminal-header">Python output</div>
            <pre className="terminal-content" role="status">
              {statusText}
            </pre>
          </section>
        </main>
      </div>
      {activeRoomId && activeProblemId && (
        <div className="editor-results">
          <ResponseArea submission={shownSubmission} />
          <SubmissionTimeline
            submissions={timeline.submissions}
            selectedId={shownSubmission?.id}
            onSelect={setShownSubmission}
          />
        </div>
      )}
    </div>
  );
}
