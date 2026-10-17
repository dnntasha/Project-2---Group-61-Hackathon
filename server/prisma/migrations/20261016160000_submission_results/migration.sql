-- Per-test results of each submission, for the submission timeline (spec 11)

-- CreateTable
CREATE TABLE "SubmissionResult" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "submissionId" INTEGER NOT NULL,
    "testCaseId" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "runtimeMs" REAL NOT NULL,
    "reason" TEXT,
    "actualOutput" TEXT,
    CONSTRAINT "SubmissionResult_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SubmissionResult_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN "reason" TEXT;

-- CreateIndex
CREATE INDEX "SubmissionResult_submissionId_idx" ON "SubmissionResult"("submissionId");