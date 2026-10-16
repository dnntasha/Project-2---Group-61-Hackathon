-- AlterTable
ALTER TABLE "Team" ADD COLUMN "fileTree" TEXT;

-- CreateTable
CREATE TABLE "TeamFile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "teamId" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    CONSTRAINT "TeamFile_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamFile_teamId_path_key" ON "TeamFile"("teamId", "path");

