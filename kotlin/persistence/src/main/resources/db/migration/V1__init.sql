-- Baseline schema: health check infrastructure
CREATE TABLE `health_check_log` (
  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `check_name` VARCHAR(255) NOT NULL,
  `is_healthy` BOOLEAN NOT NULL,
  `checked_at` DATETIME(6) NOT NULL,
  `message` VARCHAR(500)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `ix_health_check_log_checked_at` ON `health_check_log` (`checked_at`);
