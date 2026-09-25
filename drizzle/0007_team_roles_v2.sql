-- Hand-written: a rename keeps existing rows and the column default valid.
ALTER TYPE "public"."team_role" RENAME VALUE 'owner' TO 'superadmin';--> statement-breakpoint
ALTER TYPE "public"."team_role" ADD VALUE 'viewer';--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_one_superadmin" ON "team_members" USING btree ("team_id") WHERE "team_members"."role" = 'superadmin';
