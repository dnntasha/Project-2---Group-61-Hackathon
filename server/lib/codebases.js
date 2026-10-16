/**
 * This is the team codebases
 *
 * each team has a codebase perproblem, when the admin starts the event
 * a codebase is created and holds a main.py
 * with the stub entry point
 */

import { createFileNode } from '../../client/src/components/FileTree/fileTreeUtils.js';

//The stub every new codebase starts with
export const MAIN_STUB = 'def main():\n    pass\n';

//A fresh tree: a root folder holding only main.py. Contents live separately
export function starterTree() {
  const mainFile = createFileNode('main.py');
  delete mainFile.content;
  return {
    id: 'root',
    name: 'Code',
    type: 'directory',
    children: [mainFile],
  };
}

/**
 * Creates the starter codebase for every team and problem of a group and
 * points each team at the first problem.
 * Call inside the transaction that
 * starts the event
 */
export async function createStarterCodebases(tx, groupId) {
  const [teams, problems] = await Promise.all([
    tx.team.findMany({ where: { groupId }, select: { id: true } }),
    tx.problem.findMany({
      where: { groupId },
      orderBy: { orderIndex: 'asc' },
      select: { id: true },
    }),
  ]);

  for (const team of teams) {
    for (const problem of problems) {
      await tx.codebase.create({
        data: {
          teamId: team.id,
          problemId: problem.id,
          fileTree: JSON.stringify(starterTree()),
          files: { create: { path: 'main.py', content: MAIN_STUB } },
        },
      });
    }
  }

  if (problems.length > 0) {
    await tx.team.updateMany({
      where: { groupId },
      data: { activeProblemId: problems[0].id },
    });
  }
}
