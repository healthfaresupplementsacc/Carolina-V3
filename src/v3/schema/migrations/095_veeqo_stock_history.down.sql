DROP TABLE IF EXISTS v3.veeqo_stock_history;
DELETE FROM v3.settings WHERE key = 'veeqo_history.cursor';
