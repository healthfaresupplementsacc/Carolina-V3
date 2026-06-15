-- Reverte 030. Remove a coluna de método de entrega das notifications.
ALTER TABLE v3.notifications DROP COLUMN IF EXISTS delivery_method;
