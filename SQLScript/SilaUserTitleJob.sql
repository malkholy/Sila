-- =========================================================================
-- SQL Agent job: refresh SILA101.dbo.SilaUserTitleCache every hour
-- (SilaUserTitleCache.sql). Run once in SSMS -- msdb is outside SILA101, so
-- not through the deploy tool. Idempotent.
-- =========================================================================
DECLARE @job NVARCHAR(128) = N'Sila - refresh user titles';
IF NOT EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = @job)
BEGIN
    EXEC msdb.dbo.sp_add_job @job_name = @job, @description = N'Copies job / department / user group from quick and HR into SILA101.dbo.SilaUserTitleCache';
    EXEC msdb.dbo.sp_add_jobstep @job_name = @job, @step_name = N'Refresh', @subsystem = N'TSQL',
         @database_name = N'SILA101', @command = N'EXEC dbo.SilaRefreshUserTitles;';
    EXEC msdb.dbo.sp_add_jobschedule @job_name = @job, @name = N'Hourly', @freq_type = 4, @freq_interval = 1,
         @freq_subday_type = 8, @freq_subday_interval = 1, @active_start_time = 0;
    EXEC msdb.dbo.sp_add_jobserver @job_name = @job;
END
