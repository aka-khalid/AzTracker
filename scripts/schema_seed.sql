-- Dummy Data for UI Screenshots
INSERT INTO Users (chat_id, first_name, username, item_limit, role, lang) VALUES 
('123456789', 'Puppeteer', 'admin_puppet', 10, 'admin', 'en'),
('987654321', 'Ahmad', 'ahmad_masry', 3, 'user', 'masry'),
('555555555', 'Sarah', 'sarah_dev', 5, 'user', 'en'),
('666666666', 'Bad User', 'spammer1', 3, 'rejected', 'en'),
('777777777', 'Pending User', 'pending1', 3, 'pending', 'en');

INSERT INTO Global_Products (asin, name, new_price, used_price) VALUES
('B08FXX9WZX', 'Samsung Galaxy S24 Ultra, 512GB', 42500, null),
('B09G9F55NQ', 'Apple iPhone 15 Pro Max 256GB', 56000, 51000),
('B01M18UZF5', 'Sony WH-1000XM5 Wireless Headphones', 13500, null),
('B07PGL2ZSL', 'PlayStation 5 Console', 24000, null),
('B0GHOSTPRD', 'Discontinued Amazon Basics Mouse', null, null);

INSERT INTO User_Subscriptions (chat_id, asin, target_price, is_paused) VALUES
('123456789', 'B08FXX9WZX', 40000, 0),
('123456789', 'B09G9F55NQ', 55000, 0),
('987654321', 'B01M18UZF5', 12000, 0),
('987654321', 'B07PGL2ZSL', 22000, 1),
('555555555', 'B08FXX9WZX', 39000, 0);

-- Ghost subscription
INSERT INTO User_Subscriptions (chat_id, asin, target_price, is_paused) VALUES
('111111111', 'B0GHOSTPRD', 500, 0);
