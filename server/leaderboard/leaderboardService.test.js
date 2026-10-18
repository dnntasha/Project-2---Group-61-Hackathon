import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildFinalLeaderboard,
  buildProblemLeaderboard,
  calculateProblemScore,
} from './leaderboardService.js';

test('problem leaderboard ranks by P (higher) then T (lower)', () => {
  const ranked = buildProblemLeaderboard([
    { teamId: 1, P: 80, T: 1200 },
    { teamId: 2, P: 100, T: 1500 },
    { teamId: 3, P: 80, T: 900 },
    { teamId: 4, P: 80, T: 900 },
  ]);

  assert.deepEqual(
    ranked.map(({ teamId, position }) => [teamId, position]),
    [
      [2, 1],
      [3, 2],
      [4, 2],
      [1, 3],
    ]
  );
});

test('problem score is 0 for first place and 1 for last', () => {
  assert.equal(calculateProblemScore(1, 4), 0);
  assert.equal(calculateProblemScore(4, 4), 1);
  assert.equal(calculateProblemScore(1, 1), 0);
});

test('final leaderboard sums the k best scores, padding missing ones with 1', () => {
  const ranked = buildFinalLeaderboard(
    [
      {
        teamId: 1,
        teamName: 'A',
        problems: [
          { position: 1, submittingTeams: 4 },
          { position: 2, submittingTeams: 4 },
        ],
      },
      {
        teamId: 2,
        teamName: 'B',
        problems: [
          { position: 2, submittingTeams: 4 },
          { position: 3, submittingTeams: 4 },
        ],
      },
      {
        teamId: 3,
        teamName: 'C',
        problems: [{ position: 1, submittingTeams: 4 }],
      },
    ],
    2
  );

  assert.equal(ranked[0].teamId, 1);
  assert.equal(ranked[0].position, 1);
  // B (1/3 + 2/3) and C (0 + 1) tie
  assert.deepEqual(
    ranked.slice(1).map((team) => team.position),
    [2, 2]
  );
});

test('final scores that differ only by float rounding tie', () => {
  // 0.1 + 0.2 !== 0.3 in floating point, but these are equal scores
  const ranked = buildFinalLeaderboard(
    [
      {
        teamId: 1,
        teamName: 'X',
        problems: [
          { position: 2, submittingTeams: 11 },
          { position: 3, submittingTeams: 11 },
        ],
      },
      {
        teamId: 2,
        teamName: 'Y',
        problems: [
          { position: 4, submittingTeams: 11 },
          { position: 1, submittingTeams: 11 },
        ],
      },
    ],
    2
  );

  assert.deepEqual(
    ranked.map((team) => team.position),
    [1, 1]
  );
});
