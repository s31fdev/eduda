-- Правка пакетов менеджером: две новые причины в истории баланса. Движения денег
-- при этом идут прежними видами журнала — исправление пишет корректировку
-- (`ADJUSTMENT`), подарок выдаётся как обычный пакет (`PURCHASE`).
ALTER TYPE "StudentLessonsBalanceChangeReason" ADD VALUE 'PACKAGE_CORRECTED';
ALTER TYPE "StudentLessonsBalanceChangeReason" ADD VALUE 'LESSONS_GIFTED';
