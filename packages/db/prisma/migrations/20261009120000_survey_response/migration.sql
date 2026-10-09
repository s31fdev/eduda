-- Ответы на анонимные анкеты со статических страниц `/pages/`. Таблица новая и
-- ни на что не ссылается, поэтому миграция безопасна на живой базе.
CREATE TABLE "SurveyResponse" (
    "id" SERIAL NOT NULL,
    "survey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "durationSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SurveyResponse_survey_createdAt_idx" ON "SurveyResponse"("survey", "createdAt");
