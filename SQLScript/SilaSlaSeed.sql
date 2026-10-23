USE [SILA101]
GO
-- =========================================================================
-- First targets for dbo.SilaChannelSla (SQLScript/SilaSla.sql), in WORKING
-- minutes (Sat-Thu 08:00-16:00; a working day = 480). Computed 2026-10-23 from
-- each channel's last 12 months: what it achieved for 3 tickets out of 4 (75th
-- percentile), rounded up (reply to 30 minutes, finish to the hour, whole
-- working days beyond a day). Channels with fewer than 10 replied / finished
-- tickets get no target. Insert-only: never overwrites a target changed later
-- in System Settings.
-- =========================================================================
MERGE dbo.SilaChannelSla AS t
USING (VALUES
    (15, 120, 360),  -- Customer Service Support: 5742 tickets
    (452, 4800, 9120),  -- Client verification Operation: 3289 tickets
    (13, 960, 2880),  -- HR Support: 2502 tickets
    (10, 30, 120),  -- IT Support: 2501 tickets
    (25, 180, 1920),  -- 1GL FG Warehouse Support: 2030 tickets
    (22, 300, 1440),  -- Accounting Recievable Support: 1510 tickets
    (237, 60, 180),  -- ERP Operations: 1405 tickets
    (29, 30, 480),  -- Sales Logistics: 1291 tickets
    (43, 960, 10560),  -- Purchasing Support: 1204 tickets
    (63, 30, 1440),  -- 1GL RM Warhouses Support: 1064 tickets
    (131, 960, 2400),  -- 1GL Return Finished Goods: 983 tickets
    (104, 60, 300),  -- FG & Direct Sales: 930 tickets
    (65, 270, 3360),  -- Express Operations: 751 tickets
    (365, 300, 1440),  -- Projects - Prices: 712 tickets
    (403, 960, 4800),  -- Suppliers Creditors Accounting: 689 tickets
    (33, 330, 1440),  -- General Accounting Support: 610 tickets
    (58, 300, 1920),  -- 3GL Warehouse Support: 550 tickets
    (82, 480, 2400),  -- 2GL RM Warehouses: 530 tickets
    (41, 330, 6240),  -- Sales White Support: 509 tickets
    (11, 30, 180),  -- ERP Support: 508 tickets
    (90, 960, 12480),  -- Sales Colors Support: 475 tickets
    (75, 60, 1440),  -- 2GL FG Warehouse Support: 445 tickets
    (64, 150, 6720),  -- Direct Sales Support: 421 tickets
    (404, 210, 1440),  -- Transportation Accounting: 401 tickets
    (431, 2400, 2880),  -- Coloring Project Support: 349 tickets
    (69, 960, 960),  -- 1GL Security Gate: 313 tickets
    (114, 60, 3840),  -- All About Projects: 308 tickets
    (111, 150, 1440),  -- Sales Projects Support: 302 tickets
    (30, 30, 1440),  -- Quick Support: 295 tickets
    (402, 270, 1440),  -- Covenant Cash Accounting: 275 tickets
    (81, 960, 22560),  -- MR Mohamed Approval: 274 tickets
    (71, 60, 1440),  -- 1GL Receptionist Support: 272 tickets
    (78, 4800, 14400),  -- Maintenance Support: 259 tickets
    (197, 210, 300),  -- Bank Transfer: 252 tickets
    (61, 60, 2880),  -- IT Operations: 251 tickets
    (54, 120, 1440),  -- 1GL Gift Warehouse Support: 245 tickets
    (31, 300, 420),  -- Treasury Support: 243 tickets
    (80, 300, 3840),  -- 2GL Gift Warehouse Support: 242 tickets
    (387, 30, 300),  -- IT Camera: 197 tickets
    (132, 960, 7680),  -- 1GL Damaged Finish Goods: 182 tickets
    (32, 60, 1440),  -- Account Payable Support: 180 tickets
    (105, 150, 11040),  -- 3GL Lab Support: 172 tickets
    (70, 1920, 5280),  -- Transport Support: 172 tickets
    (101, 1920, 21600),  -- Sales Export Support: 156 tickets
    (83, 390, 23520),  -- Color Lab Support: 154 tickets
    (433, 1440, 54720),  -- Showroom Support - Retail ( Local - Expo: 145 tickets
    (235, 120, 1440),  -- E-invoice Support: 138 tickets
    (87, 960, 2400),  -- HSE Support: 137 tickets
    (264, 180, 960),  -- Customer Transportation Fees: 136 tickets
    (110, 210, 4800),  -- Branding Support: 135 tickets
    (442, 2400, 7680),  -- HR -  Renewals Documents and contracts: 135 tickets
    (438, 300, 7680),  -- Color Center Machine Support: 126 tickets
    (269, 390, 960),  -- Express Cards: 120 tickets
    (436, 960, 1440),  -- Projects Colors Pricing: 110 tickets
    (439, 30, 960),  -- HSE Safety Warehouse: 106 tickets
    (457, 60, 420),  -- Souq Support: 104 tickets
    (446, 960, 2880),  -- Express Redemption Request: 104 tickets
    (89, 4800, 3840),  -- 1GL Lab Support: 103 tickets
    (154, 960, 4320),  -- Payroll & Bonus: 100 tickets
    (429, 960, 1440),  -- E-Invoice Accounting: 99 tickets
    (133, 5280, 17280),  -- GLC Academy Support: 93 tickets
    (432, 330, 960),  -- Vendor Coding Support: 92 tickets
    (275, 960, 2400),  -- Export Accounting Support: 90 tickets
    (441, 390, 7200),  -- HR -  Recruitment: 90 tickets
    (236, 330, 1440),  -- KPI's: 89 tickets
    (435, 960, 2880),  -- Color Center Agent Request: 89 tickets
    (118, 1440, 27840),  -- Retail Field Support: 88 tickets
    (444, 2400, 9600),  -- Car Maintenance Support: 80 tickets
    (14, 450, 1440),  -- White Product Complaints: 79 tickets
    (451, 270, 8640),  -- Digital Marketing: 76 tickets
    (428, 120, 960),  -- Customer Zone and Route Support: 73 tickets
    (17, 60, 960),  -- Color Center Software Support: 70 tickets
    (450, 1920, 42240),  -- Customers Registration Support: 69 tickets
    (448, 30, 360),  -- Echo Support: 69 tickets
    (117, 960, 9120),  -- 4GL RM Warehouse Support: 66 tickets
    (107, NULL, 75360),  -- 3GL Security Gate: 65 tickets
    (135, 960, 2880),  -- Loading Support: 63 tickets
    (143, 240, 420),  -- Coloring Machines Accounting: 53 tickets
    (35, 960, 960),  -- Logistics Support: 49 tickets
    (443, 1440, 22560),  -- HR - Complaints and investigations: 47 tickets
    (108, 4320, NULL),  -- 2GL Lab Support: 41 tickets
    (56, 960, 12960),  -- 3GL Producation Support: 39 tickets
    (130, 1440, 18720),  -- Alex Support: 34 tickets
    (52, 270, 13440),  -- 1GL Producation Support: 29 tickets
    (407, 960, 14400),  -- Storm Shield Technical Support: 28 tickets
    (449, 150, 4320),  -- New Hire IT Setup: 26 tickets
    (426, 90, 10080),  -- 3GL Product Complaint: 23 tickets
    (397, 150, 5760),  -- 3GL Return Finished Goods: 17 tickets
    (8, NULL, 1440),  -- Quick Test: 17 tickets
    (460, 120, NULL),  -- Express Technical Support: 17 tickets
    (459, 30, 960),  -- Express Fawry: 16 tickets
    (458, 3840, 6240),  -- Automotive Lab Support: 16 tickets
    (93, 390, 12960),  -- 2GL Producation Support: 15 tickets
    (440, 960, 2400),  -- HSE Document Control: 12 tickets
    (95, 60, 2880),  -- Call Center Support: 12 tickets
    (123, NULL, 13920)  -- 2GL Receptionist Support: 11 tickets
) AS s (ChannelID, FirstReplyMinutes, FinishMinutes)
ON t.ChannelID = s.ChannelID
WHEN NOT MATCHED AND EXISTS (SELECT 1 FROM CHA.ChannelMaster c WHERE c.ChannelID = s.ChannelID) THEN
    INSERT (ChannelID, FirstReplyMinutes, FinishMinutes, LastMaintBy)
    VALUES (s.ChannelID, s.FirstReplyMinutes, s.FinishMinutes, N'claude');
GO
