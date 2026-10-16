import { prisma } from './prisma.js';

export async function loadRoom(teamId) {
  //const team = await prisma.Team.findUnique({ where: {id: teamId} });
  //return {team.fileTree, team.}

  const team = await prisma.Team.findUnique({
    where: {
      id: teamId,
    },
  });
  if (team) {
    const fileTree = team.fileTree;
    const files = team.files;
    return { fileTree, files };
  }
  return null;
}

export async function saveRoom(teamId, fileTree, files) {
  await prisma.$transaction([prisma.Team.update({ where: { id: teamId } })]);
}
