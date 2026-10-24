-- dient sample data for MySQL.
--
-- `shop` is created by MYSQL_DATABASE in docker-compose.yml. This script also
-- creates `game_service`, so one MySQL server gives the sidebar two databases.
--
-- Seeded via /docker-entrypoint-initdb.d: it runs only on a fresh volume.
-- Reset with `docker compose down -v`.

CREATE DATABASE IF NOT EXISTS game_service
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON game_service.* TO 'dient'@'%';

USE shop;

CREATE TABLE customers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE = InnoDB;

CREATE TABLE products (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  stock INT NOT NULL DEFAULT 0
) ENGINE = InnoDB;

CREATE TABLE orders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  quantity INT NOT NULL,
  total DECIMAL(10, 2) NOT NULL,
  status ENUM('pending', 'paid', 'shipped', 'cancelled') NOT NULL DEFAULT 'pending',
  notes JSON NULL,
  ordered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT orders_product_fk FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE = InnoDB;

INSERT INTO customers (name, email, active) VALUES
  ('Ada Lovelace', 'ada@example.com', 1),
  ('Grace Hopper', 'grace@example.com', 1),
  ('Alan Turing', 'alan@example.com', 1),
  ('Edsger Dijkstra', 'edsger@example.com', 0),
  ('Barbara Liskov', 'barbara@example.com', 1),
  ('Ken Thompson', 'ken@example.com', 1);

INSERT INTO products (sku, name, price, stock) VALUES
  ('SHOP-001', 'Mechanical keyboard', 149.00, 12),
  ('SHOP-002', 'Terminal mug', 18.50, 40),
  ('SHOP-003', 'Vim cheatsheet', 4.00, 200),
  ('SHOP-004', 'USB-C dock', 89.90, 7),
  ('SHOP-005', 'Noise-cancelling headphones', 249.00, 3);

INSERT INTO orders (customer_id, product_id, quantity, total, status, notes, ordered_at) VALUES
  (1, 1, 1, 149.00, 'paid', JSON_OBJECT('gift', false), NOW() - INTERVAL 8 DAY),
  (1, 3, 2, 8.00, 'paid', NULL, NOW() - INTERVAL 7 DAY),
  (2, 2, 3, 55.50, 'shipped', JSON_OBJECT('gift', true, 'message', 'Happy birthday'), NOW() - INTERVAL 6 DAY),
  (3, 4, 1, 89.90, 'pending', NULL, NOW() - INTERVAL 5 DAY),
  (4, 5, 1, 249.00, 'cancelled', JSON_OBJECT('reason', 'changed mind'), NOW() - INTERVAL 4 DAY),
  (5, 3, 10, 40.00, 'shipped', NULL, NOW() - INTERVAL 3 DAY),
  (6, 2, 2, 37.00, 'paid', NULL, NOW() - INTERVAL 2 DAY),
  (2, 1, 1, 149.00, 'pending', NULL, NOW() - INTERVAL 1 DAY),
  (5, 2, 4, 74.00, 'paid', JSON_OBJECT('gift', true), NOW()),
  (3, 5, 1, 249.00, 'pending', NULL, NOW());

USE game_service;

CREATE TABLE players (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  handle VARCHAR(60) NOT NULL UNIQUE,
  country CHAR(2) NOT NULL,
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE = InnoDB;

CREATE TABLE runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  player_id INT UNSIGNED NOT NULL,
  score INT NOT NULL,
  level INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT runs_player_fk FOREIGN KEY (player_id) REFERENCES players (id)
) ENGINE = InnoDB;

INSERT INTO players (handle, country, joined_at) VALUES
  ('ada', 'GB', NOW() - INTERVAL 400 DAY),
  ('grace', 'US', NOW() - INTERVAL 320 DAY),
  ('alan', 'GB', NOW() - INTERVAL 280 DAY),
  ('edsger', 'NL', NOW() - INTERVAL 180 DAY),
  ('barbara', 'US', NOW() - INTERVAL 90 DAY),
  ('ken', 'US', NOW() - INTERVAL 30 DAY);

-- 250 rows give the explorer several pages to walk with Ctrl+f / Ctrl+b.
INSERT INTO runs (player_id, score, level, created_at)
SELECT
  ((n - 1) % 6) + 1,
  (n * 37) % 10000,
  ((n - 1) % 12) + 1,
  NOW() - INTERVAL n MINUTE
FROM (
  SELECT a.n + b.n * 10 + c.n * 100 + 1 AS n
  FROM
    (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS a
    CROSS JOIN
    (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS b
    CROSS JOIN
    (SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
     UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) AS c
) AS numbers
WHERE n <= 250;
