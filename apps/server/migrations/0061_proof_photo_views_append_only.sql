-- The record of who was given a link to a proof photo (#560) can only grow: no row is changed or removed.
CREATE TRIGGER proof_photo_views_no_update_delete BEFORE UPDATE OR DELETE ON proof_photo_views
FOR EACH ROW EXECUTE FUNCTION reject_order_record_change();
