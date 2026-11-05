ALTER TABLE "orders" ADD COLUMN "delivery_photo_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_frozen_order_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) - 'status' - 'status_changed_at' - 'deliverer_id' - 'handover_code_hash' - 'handover_code_salt' - 'handover_code_ciphertext' - 'handover_code_attempts' - 'handover_code_blocked_until' - 'items_checked_at' - 'delivery_photo_key' - 'delivery_photo_expires_at' - 'delivery_payment' - 'proof_exception' - 'proof_exception_reason' - 'failed_delivery_reason' - 'delivery_call_attempt_at'
    = to_jsonb(OLD) - 'status' - 'status_changed_at' - 'deliverer_id' - 'handover_code_hash' - 'handover_code_salt' - 'handover_code_ciphertext' - 'handover_code_attempts' - 'handover_code_blocked_until' - 'items_checked_at' - 'delivery_photo_key' - 'delivery_photo_expires_at' - 'delivery_payment' - 'proof_exception' - 'proof_exception_reason' - 'failed_delivery_reason' - 'delivery_call_attempt_at' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is frozen at placement: % refused', TG_TABLE_NAME, TG_OP;
END;
$$;
