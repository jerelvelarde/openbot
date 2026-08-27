ALTER TABLE "external_thread_bindings" ADD CONSTRAINT "external_thread_bindings_provider_slack_check" CHECK ("external_thread_bindings"."provider" = 'slack');--> statement-breakpoint
CREATE FUNCTION "reject_external_thread_binding_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'External thread bindings are append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "external_thread_bindings_append_only"
BEFORE UPDATE OR DELETE ON "external_thread_bindings"
FOR EACH ROW
EXECUTE FUNCTION "reject_external_thread_binding_mutation"();
