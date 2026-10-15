// Problems and test cases (spec section 6).
// The admin defines an ordered sequence of problems for a group.
// Members only see them once the event has started, and never see the
// expected output of a hidden test case.
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import {
  requireGroupAdmin,
  requireGroupMember,
  requireNotStarted,
} from '../middleware/groups.js';
import { getEventStatus, EVENT_STATUS } from '../lib/eventTime.js';

const router = Router({ mergeParams: true });
router.use(requireAuth);

// Express 4 doesn't catch errors in async handlers, so pass them to next().
const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const LIMITS = {
  title: { min: 1, max: 100 },
  description: { min: 1, max: 5000 },
  format: { max: 2000 },
  testText: { max: 10000 },
  timeLimit: { min: 100, max: 60000 },
  submissionLimit: { min: 0, max: 1000 },
};

// What the admin sees: everything, including hidden tests in full.
function toAdmin(problem) {
  return {
    id: problem.id,
    orderIndex: problem.orderIndex,
    title: problem.title,
    description: problem.description,
    inputFormat: problem.inputFormat,
    outputFormat: problem.outputFormat,
    submissionLimit: problem.submissionLimit,
    testCases: (problem.testCases ?? []).map((t) => ({
      id: t.id,
      input: t.input,
      expectedOutput: t.expectedOutput,
      timeLimit: t.timeLimit,
      hidden: t.hidden,
    })),
  };
}

// What a competitor sees: the problem statement, and for hidden tests only
// the fact that they exist. Their input and expected output stay secret.
function toMember(problem) {
  return {
    id: problem.id,
    orderIndex: problem.orderIndex,
    title: problem.title,
    description: problem.description,
    inputFormat: problem.inputFormat,
    outputFormat: problem.outputFormat,
    submissionLimit: problem.submissionLimit,
    hiddenTestCount: (problem.testCases ?? []).filter((t) => t.hidden).length,
    testCases: (problem.testCases ?? [])
      .filter((t) => !t.hidden)
      .map((t) => ({
        id: t.id,
        input: t.input,
        expectedOutput: t.expectedOutput,
        timeLimit: t.timeLimit,
        hidden: false,
      })),
  };
}

function validateProblem(body, { partial = false } = {}) {
  const data = {};

  for (const field of ['title', 'description']) {
    const value = body?.[field];
    if (value === undefined) {
      if (partial) continue;
      return { error: `A problem needs a ${field}.` };
    }
    const text = String(value).trim();
    const { min, max } = LIMITS[field === 'title' ? 'title' : 'description'];
    if (text.length < min || text.length > max) {
      return { error: `The ${field} must be 1–${max} characters.` };
    }
    data[field] = text;
  }

  for (const field of ['inputFormat', 'outputFormat']) {
    const value = body?.[field];
    if (value === undefined) continue;
    const text = String(value).trim();
    if (text.length > LIMITS.format.max) {
      return {
        error: `The ${field} must be ${LIMITS.format.max} characters or fewer.`,
      };
    }
    data[field] = text;
  }

  const limit = body?.submissionLimit;
  if (limit !== undefined) {
    const { min, max } = LIMITS.submissionLimit;
    if (!Number.isInteger(limit) || limit < min || limit > max) {
      return {
        error: `The submission limit must be a whole number from ${min} to ${max} (0 means unlimited).`,
      };
    }
    data.submissionLimit = limit;
  }

  return { data };
}

function validateTestCase(body, { partial = false } = {}) {
  const data = {};

  for (const field of ['input', 'expectedOutput']) {
    const value = body?.[field];
    if (value === undefined) {
      if (partial) continue;
      return {
        error: `A test case needs an ${field === 'input' ? 'input' : 'expected output'}.`,
      };
    }
    const text = String(value);
    if (text.length > LIMITS.testText.max) {
      return { error: 'Test case text must be 10000 characters or fewer.' };
    }
    data[field] = text;
  }

  const time = body?.timeLimit;
  if (time !== undefined) {
    const { min, max } = LIMITS.timeLimit;
    if (!Number.isInteger(time) || time < min || time > max) {
      return {
        error: `The runtime limit must be a whole number of milliseconds from ${min} to ${max}.`,
      };
    }
    data.timeLimit = time;
  }

  if (body?.hidden !== undefined) {
    if (typeof body.hidden !== 'boolean') {
      return { error: 'Hidden must be true or false.' };
    }
    data.hidden = body.hidden;
  }

  return { data };
}

// Loads a problem and checks it belongs to the group in the URL, so an admin
// of one group can never reach another group's problems.
async function loadProblem(req, res, next) {
  const problemId = Number(req.params.problemId);
  const problem = Number.isInteger(problemId)
    ? await prisma.problem.findUnique({
        where: { id: problemId },
        include: { testCases: true },
      })
    : null;

  if (!problem || problem.groupId !== req.group.id) {
    return res.status(404).json({ error: 'Problem not found.' });
  }
  req.problem = problem;
  next();
}

// GET /api/groups/:groupId/problems
// Admin: always. Members: only once the event has started.
router.get(
  '/',
  requireGroupMember,
  wrap(async (req, res) => {
    const started = getEventStatus(req.group) !== EVENT_STATUS.NOT_STARTED;

    if (!req.isGroupAdmin && !started) {
      // Spec: problems are revealed when the event starts.
      return res.json({ revealed: false, problems: [] });
    }

    const problems = await prisma.problem.findMany({
      where: { groupId: req.group.id },
      include: { testCases: true },
      orderBy: { orderIndex: 'asc' },
    });

    res.json({
      revealed: true,
      problems: problems.map(req.isGroupAdmin ? toAdmin : toMember),
    });
  })
);

// POST /api/groups/:groupId/problems – add a problem to the end of the list.
router.post(
  '/',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(async (req, res) => {
    const { error, data } = validateProblem(req.body);
    if (error) return res.status(400).json({ error });

    // Next position in the ordered sequence.
    const last = await prisma.problem.findFirst({
      where: { groupId: req.group.id },
      orderBy: { orderIndex: 'desc' },
    });

    const problem = await prisma.problem.create({
      data: {
        ...data,
        groupId: req.group.id,
        orderIndex: last ? last.orderIndex + 1 : 0,
      },
      include: { testCases: true },
    });

    res.status(201).json({ problem: toAdmin(problem) });
  })
);

// PATCH /api/groups/:groupId/problems/:problemId
router.patch(
  '/:problemId',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(loadProblem),
  wrap(async (req, res) => {
    const { error, data } = validateProblem(req.body, { partial: true });
    if (error) return res.status(400).json({ error });

    const problem = await prisma.problem.update({
      where: { id: req.problem.id },
      data,
      include: { testCases: true },
    });
    res.json({ problem: toAdmin(problem) });
  })
);

// DELETE /api/groups/:groupId/problems/:problemId
// Closes the gap in orderIndex so the sequence stays 0, 1, 2, ...
router.delete(
  '/:problemId',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(loadProblem),
  wrap(async (req, res) => {
    const { id, orderIndex, groupId } = req.problem;

    await prisma.$transaction(async (tx) => {
      await tx.problem.delete({ where: { id } });
      const after = await tx.problem.findMany({
        where: { groupId, orderIndex: { gt: orderIndex } },
        orderBy: { orderIndex: 'asc' },
      });
      // One at a time: orderIndex is unique per group, so a bulk shift would clash.
      for (const p of after) {
        await tx.problem.update({
          where: { id: p.id },
          data: { orderIndex: p.orderIndex - 1 },
        });
      }
    });

    res.json({ ok: true });
  })
);

// POST /api/groups/:groupId/problems/:problemId/move { direction: 'up' | 'down' }
router.post(
  '/:problemId/move',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(loadProblem),
  wrap(async (req, res) => {
    const direction = req.body?.direction;
    if (direction !== 'up' && direction !== 'down') {
      return res
        .status(400)
        .json({ error: "Direction must be 'up' or 'down'." });
    }

    const step = direction === 'up' ? -1 : 1;
    const target = req.problem.orderIndex + step;

    const neighbour = await prisma.problem.findFirst({
      where: { groupId: req.group.id, orderIndex: target },
    });
    if (!neighbour) {
      return res
        .status(409)
        .json({ error: 'That problem is already at the end of the list.' });
    }

    // Park one row at a free index first: orderIndex is unique per group,
    // so a direct swap would briefly collide.
    await prisma.$transaction(async (tx) => {
      await tx.problem.update({
        where: { id: req.problem.id },
        data: { orderIndex: -1 },
      });
      await tx.problem.update({
        where: { id: neighbour.id },
        data: { orderIndex: req.problem.orderIndex },
      });
      await tx.problem.update({
        where: { id: req.problem.id },
        data: { orderIndex: target },
      });
    });

    res.json({ ok: true });
  })
);

// POST /api/groups/:groupId/problems/:problemId/tests
router.post(
  '/:problemId/tests',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(loadProblem),
  wrap(async (req, res) => {
    const { error, data } = validateTestCase(req.body);
    if (error) return res.status(400).json({ error });

    const testCase = await prisma.testCase.create({
      data: { ...data, problemId: req.problem.id },
    });
    res.status(201).json({ testCase });
  })
);

// PATCH /api/groups/:groupId/problems/:problemId/tests/:testId
router.patch(
  '/:problemId/tests/:testId',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(loadProblem),
  wrap(async (req, res) => {
    const { error, data } = validateTestCase(req.body, { partial: true });
    if (error) return res.status(400).json({ error });

    // problemId in the filter stops editing another problem's test.
    const { count } = await prisma.testCase.updateMany({
      where: { id: Number(req.params.testId), problemId: req.problem.id },
      data,
    });
    if (count === 0)
      return res.status(404).json({ error: 'Test case not found.' });

    const testCase = await prisma.testCase.findUnique({
      where: { id: Number(req.params.testId) },
    });
    res.json({ testCase });
  })
);

// DELETE /api/groups/:groupId/problems/:problemId/tests/:testId
router.delete(
  '/:problemId/tests/:testId',
  requireGroupMember,
  requireGroupAdmin,
  requireNotStarted,
  wrap(loadProblem),
  wrap(async (req, res) => {
    const { count } = await prisma.testCase.deleteMany({
      where: { id: Number(req.params.testId), problemId: req.problem.id },
    });
    if (count === 0)
      return res.status(404).json({ error: 'Test case not found.' });
    res.json({ ok: true });
  })
);

export default router;
