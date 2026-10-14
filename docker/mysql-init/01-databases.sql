-- Solo desarrollo local: bases de datos para la app, pruebas y la base sombra de Prisma.
CREATE DATABASE IF NOT EXISTS `apidental_test` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS `apidental_shadow` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON `apidental\_%`.* TO 'apidental'@'%';
FLUSH PRIVILEGES;
