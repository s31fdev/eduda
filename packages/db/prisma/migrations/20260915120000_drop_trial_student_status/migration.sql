-- Статус «пробный» у записи в группу не выставлял ни один экшен: пробное занятие —
-- это флаг `Attendance.isTrial` на разовом посещении, без записи в группу. Записи с
-- TRIAL были только в демо-школе, их писал сид; они становятся активными.
UPDATE "StudentGroup" SET "status" = 'ACTIVE' WHERE "status" = 'TRIAL';

-- Последняя строка журнала обязана совпадать с колонкой, поэтому те же записи
-- переписываются и в нём.
UPDATE "StatusChange" SET "toStatus" = 'ACTIVE' WHERE "entity" = 'STUDENT_GROUP' AND "toStatus" = 'TRIAL';
UPDATE "StatusChange" SET "fromStatus" = 'ACTIVE' WHERE "entity" = 'STUDENT_GROUP' AND "fromStatus" = 'TRIAL';

-- AlterEnum
CREATE TYPE "StudentStatus_new" AS ENUM ('ACTIVE', 'DISMISSED', 'TRANSFERRED', 'COMPLETED', 'ARCHIVED');
ALTER TABLE "StudentGroup" ALTER COLUMN "status" TYPE "StudentStatus_new" USING ("status"::TEXT::"StudentStatus_new");
ALTER TYPE "StudentStatus" RENAME TO "StudentStatus_old";
ALTER TYPE "StudentStatus_new" RENAME TO "StudentStatus";
DROP TYPE "StudentStatus_old";
