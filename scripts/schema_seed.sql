-- Dummy Data for UI Screenshots
INSERT INTO users (chat_id, first_name, username, is_premium, role, language) VALUES 
('123456789', 'Puppeteer', 'admin_puppet', 1, 'admin', 'en'),
('987654321', 'Ahmad', 'ahmad_masry', 0, 'user', 'ar'),
('555555555', 'Sarah', 'sarah_dev', 1, 'user', 'en'),
('666666666', 'Bad User', 'spammer1', 0, 'rejected', 'en'),
('777777777', 'Pending User', 'pending1', 0, 'pending', 'en');

INSERT INTO products (chat_id, asin, name, target_price, new_price, used_price, is_paused) VALUES
('123456789', 'B08FXX9WZX', 'Samsung Galaxy S24 Ultra, 512GB', 40000, 42500, null, 0),
('123456789', 'B09G9F55NQ', 'Apple iPhone 15 Pro Max 256GB', 55000, 56000, 51000, 0),
('987654321', 'B01M18UZF5', 'Sony WH-1000XM5 Wireless Headphones', 12000, 13500, null, 0),
('987654321', 'B07PGL2ZSL', 'PlayStation 5 Console', 22000, 24000, null, 1),
('555555555', 'B08FXX9WZX', 'Samsung Galaxy S24 Ultra, 512GB', 39000, 42500, null, 0);

-- Ghost product
INSERT INTO products (chat_id, asin, name, target_price, new_price, used_price, is_paused) VALUES
('111111111', 'B0GHOSTPRD', 'Discontinued Amazon Basics Mouse', 500, null, null, 0);

-- History
INSERT INTO history (asin, price_new, price_used, timestamp) VALUES
('B08FXX9WZX', 45000, null, strftime('%s', 'now', '-5 days')),
('B08FXX9WZX', 44000, null, strftime('%s', 'now', '-4 days')),
('B08FXX9WZX', 43500, null, strftime('%s', 'now', '-3 days')),
('B08FXX9WZX', 42500, null, strftime('%s', 'now', '-2 days'));
