-- Reverte 032. Remove os destinos de envio (sem eventos ainda na criação).
DELETE FROM v3.activity_types WHERE slug IN ('shipping_walmart', 'shipping_amazon');
