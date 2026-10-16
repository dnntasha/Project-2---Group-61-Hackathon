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
export async function loadRoom(teamId) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    // `include` joins the related TeamFile rows into the result
    include: { files: true },
  });
  if (!team || !team.fileTree) return null;

  const files = Object.fromEntries(team.files.map((f) => [f.path, f.content]));
  return { fileTree: JSON.parse(team.fileTree), files };
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
export async function saveRoom(teamId, fileTree, files) {
  const paths = Object.keys(files);
  await prisma.$transaction([
    prisma.team.update({
      where: { id: teamId },
      data: { fileTree: JSON.stringify(fileTree) },
    }),
    ...paths.map((path) =>
      prisma.teamFile.upsert({
        where: { teamId_path: { teamId, path } },
        update: { content: files[path] },
        create: { teamId, path, content: files[path] },
      })
    ),
    prisma.teamFile.deleteMany({
      // notIn: [] matches every row, which is right when the room has no files
      where: { teamId, path: { notIn: paths } },
    }),
  ]);
}
