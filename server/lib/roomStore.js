import { prisma } from './prisma.js';

export async function loadRoom(teamId) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { files: true },
  });
  if (!team) return null;
  const fileTree = team.fileTree ? JSON.parse(team.fileTree) : null;
  const files = Object.fromEntries(team.files.map((f) => [f.path, f.content]));
  return { fileTree, files };
}

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
      where: { teamId, path: { notIn: paths } },
    }),
  ]);
}
