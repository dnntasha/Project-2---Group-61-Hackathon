import {
  buildProblemLeaderboard,
  buildFinalLeaderboard,
} from './leaderboardService.js';

const problemScores = [
  {
    teamId: 1,
    teamName: 'Team A',
    P: 80,
    T: 1200,
  },
  {
    teamId: 2,
    teamName: 'Team B',
    P: 100,
    T: 1500,
  },
  {
    teamId: 3,
    teamName: 'Team C',
    P: 80,
    T: 900,
  },
  {
    teamId: 4,
    teamName: 'Team D',
    P: 80,
    T: 900,
  },
];

console.log('Problem leaderboard:');
console.table(buildProblemLeaderboard(problemScores));

const finalTeams = [
  {
    teamId: 1,
    teamName: 'Team A',
    problems: [
      { position: 1, submittingTeams: 4 },
      { position: 2, submittingTeams: 4 },
    ],
  },
  {
    teamId: 2,
    teamName: 'Team B',
    problems: [
      { position: 2, submittingTeams: 4 },
      { position: 3, submittingTeams: 4 },
    ],
  },
  {
    teamId: 3,
    teamName: 'Team C',
    problems: [{ position: 1, submittingTeams: 4 }],
  },
];

console.log('Final leaderboard:');
console.table(buildFinalLeaderboard(finalTeams, 2));
