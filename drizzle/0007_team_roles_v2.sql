-- Hand-written: drizzle-kit's version created the index before 'superadmin' existed and dropped the
-- team_role type while team_members.role still defaulted to it. Renaming a value keeps every existing
-- row and default valid (an owner becomes the superadmin), and viewer is only added here, not used.
ALTER TYPE "public"."team_role" RENAME VALUE 'owner' TO 'superadmin';--> statement-breakpoint
ALTER TYPE "public"."team_role" ADD VALUE 'viewer';--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_one_superadmin" ON "team_members" USING btree ("team_id") WHERE "team_members"."role" = 'superadmin';
