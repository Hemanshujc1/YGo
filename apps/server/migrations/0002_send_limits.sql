CREATE TABLE email_code_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  address text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_code_sends_email_sent_at_idx ON email_code_sends (email, sent_at);
CREATE INDEX email_code_sends_address_sent_at_idx ON email_code_sends (address, sent_at);
