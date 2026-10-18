/**
 * Database persistence for collaborative editor rooms.
 *
 * A "room" lives in server memory while people are editing (see server.js).
 * This module is the bridge between that in-memory state and SQLite so the
 * work survives a server restart. It uses two places in the database:
 *  - Team.fileTree: the folder/file structure, stored as a JSON string
 *  - TeamFile rows: one row per file, holding its path and its text contents
 *
 * Rooms are keyed by team ("team-<id>"), so everything here is keyed by teamId.
 */
import { prisma } from './prisma.js';

/**
 * Reads a team's saved editor state.
 *
 * Returns `{ fileTree, files }` where `fileTree` is the parsed tree object and
 * `files` maps each file path to its contents (e.g. { 'main.py': 'print(1)' }).
 * Returns null when nothing has been saved yet (a brand new team) or the team
 * no longer exists, so the caller can fall back to the default starter file.
 */
export async function loadRoom(teamId, problemId) {
  const codebase = await prisma.codebase.findUnique({
    where: { teamId_problemId: { teamId, problemId } },
    // `include` joins the related TeamFile rows into the result
    include: { files: true },
  });
  if (!codebase) return null;

  const files = Object.fromEntries(
    codebase.files.map((f) => [f.path, f.content])
  );
  return { fileTree: JSON.parse(codebase.fileTree), files };
}

/**
 * Writes a team's whole editor state to the database.
 *
 * `fileTree` is the room's tree object and `files` maps path -> contents.
 * Everything happens inside one transaction, so a crash half way through can
 * never leave a tree that disagrees with the saved files:
 *  1. store the tree JSON on the team
 *  2. upsert every file ("update the row if it exists, otherwise insert it";
 *     `teamId_path` is the compound unique key declared on TeamFile)
 *  3. delete rows for files that were deleted or renamed away
 */
export async function saveRoom(teamId, problemId, fileTree, files) {
  const paths = Object.keys(files);
  const tree = JSON.stringify(fileTree);
  const { id: codebaseId } = await prisma.codebase.upsert({
    where: { teamId_problemId: { teamId, problemId } },
    update: {},
    create: { teamId, problemId, fileTree: tree },
  });
  await prisma.$transaction([
    prisma.codebase.update({
      where: { id: codebaseId },
      data: { fileTree: tree },
    }),
    ...paths.map((path) =>
      prisma.codebaseFile.upsert({
        where: { codebaseId_path: { codebaseId, path } },
        update: { content: files[path] },
        create: { codebaseId, path, content: files[path] },
      })
    ),
    prisma.codebaseFile.deleteMany({
      // notIn: [] matches every row, which is right when the room has no files
      where: { codebaseId, path: { notIn: paths } },
    }),
  ]);
}
