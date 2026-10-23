USE [SILA101]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
-- =========================================================================
-- [dbo].[SilaChannelPurpose] -- what each ticket channel handles, for people
-- choosing where to open a ticket (the New ticket picker) and for the Sila
-- assistant. One row per CHA.ChannelMaster channel; a channel without a row
-- simply has no description. Kept out of CHA.ChannelMaster on purpose: the
-- mobile app's procedures read that table and a new column there could break
-- a SELECT * copy.
--
--   Purpose           what the channel is for (a sentence or two)
--   Examples          typical requests, separated by ';'
--   OfferInAssistant  1 = the assistant may suggest it (0: tests, dormant, logs)
--
-- Edited in System Settings > Channels (dbo.APISilaWebOperation 'Save channel
-- purpose', user mhd only). The seed below comes from docs/channel-purposes.csv
-- (drafted 2026-10-23 from each channel's last 25 ticket subjects) and only
-- adds missing rows: running the script again never overwrites an edit.
-- Idempotent. Deploy with deploy.sh or in SSMS.
-- =========================================================================
IF OBJECT_ID(N'dbo.SilaChannelPurpose', N'U') IS NULL
    CREATE TABLE dbo.SilaChannelPurpose (
        ChannelID        INT            NOT NULL CONSTRAINT PK_SilaChannelPurpose PRIMARY KEY,
        Purpose          NVARCHAR(1000) NOT NULL CONSTRAINT DF_SilaChannelPurpose_Purpose DEFAULT (N''),
        Examples         NVARCHAR(1000) NOT NULL CONSTRAINT DF_SilaChannelPurpose_Examples DEFAULT (N''),
        OfferInAssistant BIT            NOT NULL CONSTRAINT DF_SilaChannelPurpose_Offer DEFAULT (1),
        LastMaintBy      NVARCHAR(50)   NOT NULL CONSTRAINT DF_SilaChannelPurpose_By DEFAULT (N''),
        LastMaintDate    DATETIME       NOT NULL CONSTRAINT DF_SilaChannelPurpose_Date DEFAULT (GETDATE())
    );
GO
MERGE dbo.SilaChannelPurpose AS t
USING (VALUES
    (8, N'Quick test channel (private).', N'', 0),
    (10, N'IT help desk: laptops and PCs, printers, email, flash drives, internal phones, software problems.', N'Laptop request; printer not working; email problem', 1),
    (11, N'ERP system support: errors and changes in the ERP (journal entries, reports, driver data, loans, leave balances, new line types).', N'Error opening a journal entry; new report; edit driver data', 1),
    (12, N'Developer support (mostly tests, private).', N'', 0),
    (13, N'HR support: attendance, deductions, HR letters, salary details, allowances, leaves, penalties.', N'HR letter; attendance correction; salary details', 1),
    (14, N'White products complaints (e.g. 3030, 2020, putty, sealer) (private).', N'Complaint about 3030 product', 1),
    (15, N'Customer orders: entering, editing, approving or cancelling customer orders, promotions on orders, item exceptions.', N'Customer order needs editing; cancel an order; apply promotion', 1),
    (17, N'Tinting software at color centers: activate / stop a center''s system, sync problems, color database and trends, program pricing for export customers (private).', N'Activate tinting system for a center; sync problem; stop a center''s system', 1),
    (22, N'Customer credit and collections: credit limit approvals, customer account statements, bank deposits not yet on the system, daily loadings and delivery notes follow-up, shared freight.', N'Approve extra credit for a customer; customer statement; deposits not on the system', 1),
    (25, N'Finished-goods warehouse plant 1 (1GL): daily loading requests, transfers to Shabab, shortages or excess in customer orders, project samples, management gifts.', N'Shortage in a customer order; samples for a project; today''s loading', 1),
    (29, N'Sales logistics: daily orders dispatch, changing the carrier, loading customer orders, changing delivery contact.', N'Change the carrier; today''s orders; load a customer order', 1),
    (30, N'Quick / Sila apps support: login, app errors, chats, channels.', N'App won''t open; duplicate chat', 1),
    (31, N'Treasury: cash deposits and transfers, custody (عهدة) top-ups for factory safes, long advances closing, cheques and guarantee-cheque returns, foreign-currency deposits.', N'Deposit for a supplier; transfer custody to Qena safe; return guarantee cheque', 1),
    (32, N'Payments to suppliers against purchase orders, supplier returns and debit notes, VAT audit follow-up, vendor payment terms, supplier statements.', N'Pay PO 2611588; supplier return (Megapack); VAT inspection notes; new payment term', 1),
    (33, N'General accounting: supplier dues to transfer, cash payments, HR and branch petty-cash (custody) settlements, salary deductions, insurance refunds.', N'Supplier dues to pay today; cash for printers; HR custody settlement', 1),
    (35, N'Logistics (imports / courier): DHL, customs clearing, supplier shipment documents, analysis certificates (private).', N'DHL invoices; shipment documents', 1),
    (41, N'White products sales: customer credit, product availability, agent requests, daily quota, complaints.', N'Extra credit for a customer; product availability', 1),
    (43, N'Purchasing: purchase requests, POs, supplier deliveries and shortages, office and factory supplies.', N'Purchase request; supplier delivery delay', 1),
    (52, N'Plant 1 production: monthly production plans, packaging changes, technical follow-up.', N'', 1),
    (54, N'Gift warehouse plant 1: promotional gifts and printed material for customers and centers.', N'Gifts for a customer; catalogues', 1),
    (56, N'Plant 3 production: production plans, shortages, quotas (private).', N'', 1),
    (58, N'Warehouse plant 3: raw-material receipts by PO, transfers, export loading.', N'Receipt PO 2611882', 1),
    (61, N'IT operations: mobile lines and packages, phone replacement, telecom bills, leavers'' accounts, API access.', N'Phone replacement; upgrade internet package', 1),
    (63, N'Raw-material warehouse plant 1: supplier receipts by PO, transfers between plants.', N'Receipt of code 562; transfer from Obour', 1),
    (64, N'Direct sales: direct-sale requests, sales reports, collections and customer debts.', N'Direct sale request; collection statement', 1),
    (65, N'Express operations: Express loyalty complaints (cards, school bags, gifts, couriers).', N'School bag missing items; damaged card', 1),
    (69, N'Plant 1 security gate: shared daily orders list, vehicle in/out.', N'', 0),
    (70, N'Transport: drivers and company vehicles, deliveries, traffic fines and licences, distributing stands and gifts.', N'Need a driver; deliver gifts; traffic fines', 1),
    (71, N'Reception plant 1: meeting-room booking, visitors, reception daily report.', N'Book the meeting room', 1),
    (73, N'Marketing support (dormant since Jun 2025, private).', N'', 0),
    (74, N'Purchasing approvals (dormant since 2023, private).', N'', 0),
    (75, N'Finished-goods warehouse plant 2 (2GL): loading requests and additions, returns from color centers, coloring orders and samples, transfers.', N'Loading additions today; return from a color center', 1),
    (78, N'Building and factory maintenance: AC, doors, electrical, pumps, forklifts, new installations.', N'AC not working; broken door; forklift repair', 1),
    (80, N'Gift warehouse plant 2: gifts, catalogues and color cards for centers, export gift loading.', N'NCS color card for a customer; gifts for a center', 1),
    (81, N'Approvals by Mr Mohamed: purchase orders, budgets, contract renewals and spending approvals.', N'Approve PO; approval request', 1),
    (82, N'Raw-material warehouse plant 2: transfers, supplier plans and returns, analysis certificates.', N'Transfer code 1503 to Obour', 1),
    (83, N'Color lab: color formula requests (RAL / customer colors), colorant complaints at color centers.', N'Color formula request (RAL); colorant clotting at a center', 1),
    (87, N'Health, safety and environment: accidents, non-conformity reports, safety training, environmental measurements.', N'Forklift accident report; non-conformity', 1),
    (88, N'Approvals by Mr Malik (dormant since May 2025).', N'', 0),
    (89, N'Plant 1 lab: test results, TDS, sample codes, raw-material shelf-life extension (private).', N'Test result for code 170; extend raw-material expiry', 1),
    (90, N'Color sales: color-center customers, targets, tinting complaints, opening gifts, customer trips.', N'Color center target; opening gifts', 1),
    (93, N'Plant 2 production: monthly production plans, BOM changes (private).', N'', 1),
    (94, N'Plant 2 security gate (low volume).', N'', 0),
    (95, N'Call center: customer complaints received by phone, campaign follow-up calls, Fawry transfers, GLC Academy enquiries, job-application replies.', N'Customer complaint by phone; campaign follow-up; academy enquiry', 1),
    (101, N'Export sales: export requests by country, agent enquiries, export invoices and gifts.', N'Export request (Libya); agent enquiry', 1),
    (104, N'Finished goods for direct sales: product availability, products outside the plan, additions.', N'Make a product available; product outside plan', 1),
    (105, N'Plant 3 lab: test results, raw-material requests and expiry (private).', N'Test result for code 70', 1),
    (106, N'Plant 4 (4GL) finished-goods warehouse: receipts, office supplies, small returns (low volume).', N'', 1),
    (107, N'Plant 3 security gate: visitor and supplier visits.', N'Supplier visit to the factory', 0),
    (108, N'Plant 2 lab: test results, COA approval, samples (private).', N'COA approval for code 70', 1),
    (110, N'Branding: logo, signage design, catalogues, business cards, stickers, SDS/EPD certificates, giveaways.', N'Design a showroom sign; business cards; SDS certificate', 1),
    (111, N'Projects sales: project quotation requests, project orders, samples for projects.', N'Quotation request for a project', 1),
    (114, N'Projects: requests for project samples.', N'Samples for a project', 1),
    (117, N'Raw-material warehouse plant 4: receipts of trips.', N'', 1),
    (118, N'Retail field: shop signs, display stands, opening gifts for centers (private).', N'Sign for a dealer''s shop; display stand', 1),
    (121, N'Clinic: medical supplies, medical reports, first aid (dormant since Sep 2025).', N'', 0),
    (123, N'Reception plant 2: meeting-room booking, visitors.', N'Book the meeting room (2GL)', 1),
    (130, N'Alexandria branch: receipts, supplies, warehouse rent.', N'', 1),
    (131, N'Customer returns of finished goods (1GL): returns with the next order, damaged returns approval.', N'Return from a customer; damaged return', 1),
    (132, N'Damaged finished goods at plant 1 (1GL): damages found on customer trucks or returned.', N'Damaged goods on a customer''s truck', 1),
    (133, N'GLC Academy: painter training requests for color centers, academy points.', N'Academy training for a center''s painters', 1),
    (135, N'Loading support: moving materials/parcels to color centers with customer trucks, arranging a pickup truck.', N'Send supplies to a center with a customer truck', 1),
    (138, N'Public relations / legal papers: power of attorney, commercial register, ISO certificates, permits, utility bills.', N'Commercial register; ISO certificate for a tender', 1),
    (140, N'R&D (dormant since May 2025).', N'', 0),
    (141, N'IT purchasing: buying IT equipment, toner, printer maintenance invoices (private, rarely used).', N'Buy toner; IT equipment invoice', 1),
    (142, N'Physical counting 2022 (closed project).', N'', 0),
    (143, N'Accounting for tinting machines: machine deposits and renewals, coding the center, machine exit/return, machine pricing (private).', N'Machine deposit for a center; code center for renewal; machine exit', 1),
    (144, N'AR for MEA (dormant since 2024, private).', N'', 0),
    (146, N'Services: cleaning workers, cleaning supplies, temporary helpers, office services.', N'Need a cleaner; cleaning supplies', 1),
    (147, N'Loading MEA (dormant since 2024).', N'', 0),
    (148, N'General accounting MEA (dormant since 2023).', N'', 0),
    (149, N'Sales export MEA (dormant since 2023, private).', N'', 0),
    (150, N'Color sales upper management: customer targets and achievements, sales reports.', N'', 1),
    (154, N'Payroll and bonuses processing (private).', N'Monthly payroll; school-year grant', 1),
    (197, N'Bank transfers to suppliers and payees.', N'Bank transfers for today', 1),
    (235, N'E-invoice system errors (invalid documents) (private).', N'Invalid e-invoice', 1),
    (236, N'KPIs and employee performance evaluations.', N'Quarterly evaluation; KPI correction', 1),
    (237, N'ERP operations requests: bills of material, BOM packing / shop orders, new item codes, item planning, e-invoice items, reopening documents.', N'New BOM; add new item codes; open item on e-invoice', 1),
    (257, N'Radio (walkie-talkie) devices: faults and maintenance (private).', N'Radio device fault', 1),
    (264, N'Freight (نولون) for customer orders: calculating, approving or changing a customer''s transport fee.', N'Freight for a customer''s order; approve freight', 1),
    (269, N'Express cards: ordering Express / Storm Shield cards, card transfers, serial errors (private).', N'Order Express cards; transfer cards', 1),
    (275, N'Export accounting: export invoices, e-invoices for export, Wirechoice, VAT notes on export.', N'Export invoices up to a date; export e-invoice', 1),
    (283, N'Express complaints (no tickets yet, private).', N'', 0),
    (284, N'Central raw-material warehouse: stock checks, shortages, tanks (private).', N'', 1),
    (343, N'IT support for MEA (dormant since Jan 2025, private).', N'', 0),
    (345, N'Developer test channel (private).', N'', 0),
    (365, N'Project price quotations (private).', N'Quotation for a project', 1),
    (381, N'Setting up a brand-new color center / showroom: new device and center setup (private).', N'New showroom at a center; prepare device for a new center', 1),
    (387, N'CCTV cameras: camera not working, footage review, moving cameras.', N'Review camera footage; camera down', 1),
    (397, N'Customer returns of plant 3 (3GL) products and their approval.', N'Approve a customer return (3GL)', 1),
    (398, N'Damaged / defective finished goods at plant 3 (3GL): varnishes and hardeners, expired hardeners, product replacement.', N'Replace defective hardener; return varnish', 1),
    (402, N'Petty cash (custody / عهدة) requests and expense settlements for factories, HR and direct sales.', N'Request a custody; settle expenses for Qena factory', 1),
    (403, N'Supplier and creditor payments: supplier disbursements, advance payments, contract review, transfer approvals.', N'Pay supplier X; advance payment; review a contract', 1),
    (404, N'Transportation accounting: drivers'' trip bonuses, transfer-truck requests, fleet expenses, trip reviews.', N'Trip bonus for Qena trucks; transfer truck for raw materials', 1),
    (405, N'Bank accounting: bank transfer refunds, deposit confirmation, bank commissions and reconciliation.', N'Confirm a customer deposit; bank commission', 1),
    (407, N'Storm Shield technical support for projects: site visits, samples, training, center support (private).', N'Storm Shield samples for a project; site visit', 1),
    (408, N'Employee payroll questions: deductions, payslip, bank transfer of salary.', N'Salary deduction question; payslip', 1),
    (412, N'Old app (Quick) testing (dormant, private).', N'', 0),
    (420, N'Express finance / Loynova reports (dormant since Jan 2025, private).', N'', 0),
    (426, N'Product complaints for plant 3 products (putty, Woodguard, varnish, nitrocellulose) (private).', N'Complaint about Icon putty; varnish thickening', 1),
    (428, N'Customer delivery zones and routes: setting the freight zone/route for a customer.', N'Set freight zone for a customer', 1),
    (429, N'E-invoice accounting for company expenses: hotel, flights, utilities, telecom invoices.', N'Hotel e-invoice for a mission; Etisalat invoice', 1),
    (431, N'Filling (tinting) project customers'' orders.', N'Fill order for a project customer', 1),
    (432, N'Creating and updating vendor (supplier) master data.', N'Code a new vendor; update vendor data', 1),
    (433, N'Showrooms (local and export): showroom works for color centers.', N'Showroom for a center', 1),
    (434, N'Product complaints raised by color centers (private).', N'Complaint from a color center about a product', 1),
    (435, N'Requests to open a new color center (agent / tinting machine request) (private).', N'Request a new color center; request a tinting machine', 1),
    (436, N'Product pricing for projects (colors).', N'Price products for a project', 1),
    (437, N'Network infrastructure: network issues, ports, landlines, microwave links (private).', N'Network down; landline fault', 1),
    (438, N'Tinting-machine hardware: maintenance, calibration, shakers, tanks, colorant clotting, color differences, maintenance-contract add/remove.', N'Machine maintenance at a center; colorant clotting; remove center from maintenance contract', 1),
    (439, N'Safety store: PPE issue, uniforms, gloves.', N'Need safety shoes / uniform', 1),
    (440, N'QHSE document control: new / updated forms and procedures.', N'Add a new form', 1),
    (441, N'Recruitment: new-hire requirements, interview schedules, hiring requests, meeting-room booking (HR).', N'New hire requirements; interview appointment', 1),
    (442, N'Renewal of employment contracts and HR documents.', N'Renew contracts for a department', 1),
    (443, N'Employee complaints and investigations.', N'Open an investigation; disciplinary memo', 1),
    (444, N'Company car maintenance: repairs, batteries, tyres, fuel invoices.', N'Car battery replacement; service the Elantra', 1),
    (445, N'Product and market research: market studies, website products, product training.', N'Market study for a governorate', 1),
    (446, N'Express redemptions: recharge card or balance not received, school-bag gift complaints (private).', N'Recharge card not received; balance not transferred', 1),
    (447, N'Export order logistics: export orders by country, proformas, container counts.', N'New export order (Yemen); proforma for a new country; containers for Syria', 1),
    (448, N'Echo app: dealer / sub-dealer accounts, moving customer codes, mobile numbers.', N'Activate a new customer account on Echo', 1),
    (449, N'IT setup for new hires: PC, phone, accounts (private).', N'New hire IT requirements', 1),
    (450, N'Registering new customers (coding) and updating customer documents: color-center customers, project customers, tax papers.', N'Code new project customer; new code for a color center; update tax documents', 1),
    (451, N'Digital marketing: website, social media videos, campaigns, agency invoices.', N'TikTok videos; campaign shoot', 1),
    (452, N'Customer account verification for Express (private).', N'Verify account 24071404', 1),
    (453, N'Projects marketing: LinkedIn content, engineers'' events (low volume).', N'', 1),
    (454, N'Syria export (no tickets yet).', N'', 0),
    (455, N'Libya export (no tickets yet).', N'', 0),
    (456, N'Test channel (inactive).', N'', 0),
    (457, N'Souq app support: app update/install problems, customer quotas, center accounts.', N'Souq app won''t update; customer quota wrong', 1),
    (458, N'Automotive lab: issuing samples.', N'Issue sample code 1575', 1),
    (459, N'Express Fawry: Fawry gifts and balances not received, card registration, pending Fawry orders.', N'Fawry gift delayed; cancel pending Fawry orders', 1),
    (460, N'Express technical: compensation points, card serial batches, Storm Shield card recharge issues, campaign notifications.', N'Add compensation points; recharge issue', 1),
    (461, N'Bank operations: deposits, transfers, bank authorisations, bank accounts, unidentified amounts, refunds to the sending account.', N'Unidentified deposit; refund a transfer to its sender; bank authorisation', 1)
) AS s (ChannelID, Purpose, Examples, OfferInAssistant)
ON t.ChannelID = s.ChannelID
WHEN NOT MATCHED AND EXISTS (SELECT 1 FROM CHA.ChannelMaster c WHERE c.ChannelID = s.ChannelID) THEN
    INSERT (ChannelID, Purpose, Examples, OfferInAssistant, LastMaintBy)
    VALUES (s.ChannelID, s.Purpose, s.Examples, s.OfferInAssistant, N'claude');
GO
