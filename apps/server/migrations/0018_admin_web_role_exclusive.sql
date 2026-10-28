-- An account holds one Admin web role (#343): refuse a second membership in the other table.
-- The lock makes two inserts for one account take turns, so the later one sees the earlier.
CREATE FUNCTION forbid_second_admin_web_role() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.account_id::text));
  IF (TG_TABLE_NAME = 'admin_memberships' AND EXISTS (SELECT 1 FROM area_manager_memberships WHERE account_id = NEW.account_id))
    OR (TG_TABLE_NAME = 'area_manager_memberships' AND EXISTS (SELECT 1 FROM admin_memberships WHERE account_id = NEW.account_id)) THEN
    RAISE EXCEPTION 'account already has the other Admin web role' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER admin_memberships_one_role BEFORE INSERT ON admin_memberships
  FOR EACH ROW EXECUTE FUNCTION forbid_second_admin_web_role();
--> statement-breakpoint
CREATE TRIGGER area_manager_memberships_one_role BEFORE INSERT ON area_manager_memberships
  FOR EACH ROW EXECUTE FUNCTION forbid_second_admin_web_role();
