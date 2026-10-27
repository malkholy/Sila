/*
  005 -- the SQL login of the Sila Mail API's internal copy (10.1.245.2:9001).
  It only READS the [mail] tables of [InternalMail]: users read their mail and
  admins see the Mail Monitor; every change still goes through the Mail
  Connector API. Run in SSMS on silamail.glcpaints.com; put your own strong
  password below first. Safe to run again.
*/
USE [master];
GO
IF SUSER_ID(N'sila_mail_api') IS NULL
    CREATE LOGIN [sila_mail_api] WITH PASSWORD = N'<strong password>', CHECK_POLICY = ON;
GO
USE [InternalMail];
GO
IF USER_ID(N'sila_mail_api') IS NULL
    CREATE USER [sila_mail_api] FOR LOGIN [sila_mail_api];
GRANT SELECT ON SCHEMA::[mail] TO [sila_mail_api];
GO
