const SCORE_EPSILON = 1e-9;

export function buildProblemLeaderboard(scores) {
  const sorted = [...scores].sort((a, b) => {
    // Higher percentage passed is better
    if (a.P !== b.P) {
      return b.P - a.P;
    }

    // If percentages are equal, lower runtime is better
    return a.T - b.T;
  });

  let currentRank = 0;
  let previousScore = null;

  return sorted.map((score) => {
    const isSameScore =
      previousScore &&
      score.P === previousScore.P &&
      score.T === previousScore.T;

    if (!isSameScore) {
      currentRank += 1;
    }

    const result = {
      ...score,
      position: currentRank,
    };

    previousScore = score;

    return result;
  });
}

// Converts a team's position on one problem leaderboard
// into the score used for the final leaderboard.
export function calculateProblemScore(position, submittingTeams) {
  const otherTeams = submittingTeams - 1;

  if (otherTeams <= 0) {
    return 0;
  }

  return (position - 1) / otherTeams;
}

export function buildFinalLeaderboard(teams, k) {
  const scoredTeams = teams.map((team) => {
    const problemScores = team.problems.map((problem) =>
      calculateProblemScore(problem.position, problem.submittingTeams)
    );

    // Lower scores are better, so take the k smallest
    problemScores.sort((a, b) => a - b);

    const bestScores = problemScores.slice(0, k);
    while (bestScores.length < k) {
      bestScores.push(1);
    }

    const finalScore = bestScores.reduce((total, score) => total + score, 0);

    return {
      teamId: team.teamId,
      teamName: team.teamName,
      finalScore,
      problemScores: bestScores,
    };
  });

  scoredTeams.sort((a, b) => a.finalScore - b.finalScore);

  let currentRank = 0;
  let previousScore = null;

  return scoredTeams.map((team) => {
    // Scores are sums of fractions, so compare with a tolerance
    // (0.1 + 0.2 must tie with 0.3)
    if (
      previousScore === null ||
      Math.abs(team.finalScore - previousScore) > SCORE_EPSILON
    ) {
      currentRank += 1;
    }

    const result = {
      ...team,
      position: currentRank,
    };

    previousScore = team.finalScore;

    return result;
  });
}
