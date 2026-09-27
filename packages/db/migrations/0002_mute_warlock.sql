CREATE TABLE "message_mentions" (
	"message_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	CONSTRAINT "message_mentions_message_id_participant_id_pk" PRIMARY KEY("message_id","participant_id")
);
--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_mentions_participant_idx" ON "message_mentions" USING btree ("participant_id");