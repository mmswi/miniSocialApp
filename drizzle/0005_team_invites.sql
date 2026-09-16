CREATE TABLE "team_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "team_role" NOT NULL,
	"invited_by_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_invites_team_email_unique" ON "team_invites" USING btree ("team_id","email");--> statement-breakpoint
CREATE INDEX "team_invites_team_idx" ON "team_invites" USING btree ("team_id");