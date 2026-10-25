/*
  003 -- the SQL login of the Mail External API (sila.glcpaints.com server).
  It may only read and write the [mail] tables of the [Mail] database -- no
  SILA101, no schema changes. Run in SSMS on the server that holds [Mail];
  put your own strong password below first. Safe to run again.
*/
USE [master];
GO
IF SUSER_ID(N'sila_mail_external') IS NULL
    CREATE LOGIN [sila_mail_external] WITH PASSWORD = N'<strong password>', CHECK_POLICY = ON;
GO
USE [Mail];
GO
IF USER_ID(N'sila_mail_external') IS NULL
    CREATE USER [sila_mail_external] FOR LOGIN [sila_mail_external];
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::[mail] TO [sila_mail_external];
GO
