-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "TeamInvite_userId_idx" ON "TeamInvite"("userId");

-- CreateIndex
CREATE INDEX "GroupInvite_userId_idx" ON "GroupInvite"("userId");
