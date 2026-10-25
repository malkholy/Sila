using System.Net;
using System.Text;
using System.Xml.Linq;
using Sila.MailConnector.Ews;
using Xunit;

namespace Sila.MailConnector.Tests;

public sealed class EwsSyncTests
{
    private static readonly ExchangeOptions Settings = new()
    {
        EwsUrl = "https://exchange.example.test/EWS/Exchange.asmx",
        Username = "svc", Password = "secret", AllowedDomains = ["example.test"],
    };

    private static EwsClient Client(string body) =>
        new(new HttpClient(new FakeExchange(HttpStatusCode.OK, $"""
            <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
                        xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
                        xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
              <s:Body>{body}</s:Body>
            </s:Envelope>
            """)), new StaticMonitor<ExchangeOptions>(Settings));

    [Fact]
    public async Task Item_changes_are_read_and_non_messages_skipped()
    {
        var client = Client("""
            <m:SyncFolderItemsResponse><m:ResponseMessages>
              <m:SyncFolderItemsResponseMessage ResponseClass="Success">
                <m:ResponseCode>NoError</m:ResponseCode>
                <m:SyncState>H4sIAAAA</m:SyncState>
                <m:IncludesLastItemInRange>false</m:IncludesLastItemInRange>
                <m:Changes>
                  <t:Create><t:Message><t:ItemId Id="A1" ChangeKey="CK1" /></t:Message></t:Create>
                  <t:Create><t:PostItem><t:ItemId Id="P1" ChangeKey="CKP" /></t:PostItem></t:Create>
                  <t:Update><t:MeetingRequest><t:ItemId Id="A2" ChangeKey="CK2" /></t:MeetingRequest></t:Update>
                  <t:Delete><t:ItemId Id="A3" /></t:Delete>
                  <t:ReadFlagChange><t:ItemId Id="A4" ChangeKey="CK4" /><t:IsRead>true</t:IsRead></t:ReadFlagChange>
                </m:Changes>
              </m:SyncFolderItemsResponseMessage>
            </m:ResponseMessages></m:SyncFolderItemsResponse>
            """);
        var page = await client.SyncFolderItemsAsync("mona@example.test", "INBOXID", null, 200, CancellationToken.None);
        Assert.Equal("H4sIAAAA", page.SyncState);
        Assert.False(page.IncludesLast);
        Assert.Equal(
            [
                new ItemChange(EwsChange.Create, "A1", "CK1", null),
                new ItemChange(EwsChange.Update, "A2", "CK2", null),
                new ItemChange(EwsChange.Delete, "A3", null, null),
                new ItemChange(EwsChange.ReadFlagChange, "A4", "CK4", true),
            ], page.Changes);
    }

    [Fact]
    public void Message_fields_are_parsed_in_utc()
    {
        XNamespace t = "http://schemas.microsoft.com/exchange/services/2006/types";
        var item = XElement.Parse("""
            <t:Message xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
              <t:ItemId Id="A1" ChangeKey="CK1" />
              <t:Subject>Order 4512 — شحنة</t:Subject>
              <t:DateTimeSent>2026-10-24T09:15:00Z</t:DateTimeSent>
              <t:DateTimeReceived>2026-10-24T09:15:05Z</t:DateTimeReceived>
              <t:Importance>High</t:Importance>
              <t:HasAttachments>true</t:HasAttachments>
              <t:IsDraft>false</t:IsDraft>
              <t:Preview>Please find attached</t:Preview>
              <t:ConversationId Id="CONV1" />
              <t:Flag><t:FlagStatus>Flagged</t:FlagStatus></t:Flag>
              <t:ToRecipients>
                <t:Mailbox><t:Name>Mona</t:Name><t:EmailAddress>mona@example.test</t:EmailAddress></t:Mailbox>
                <t:Mailbox><t:Name>Ali</t:Name><t:EmailAddress>ali@example.test</t:EmailAddress></t:Mailbox>
              </t:ToRecipients>
              <t:CcRecipients><t:Mailbox><t:EmailAddress>cc@example.test</t:EmailAddress></t:Mailbox></t:CcRecipients>
              <t:IsRead>false</t:IsRead>
              <t:From><t:Mailbox><t:Name>Sales</t:Name><t:EmailAddress>sales@example.test</t:EmailAddress></t:Mailbox></t:From>
              <t:InternetMessageId>&lt;abc@example.test&gt;</t:InternetMessageId>
            </t:Message>
            """);
        var mail = EwsClient.ParseItem(item)!;
        Assert.Equal("Order 4512 — شحنة", mail.Subject);
        Assert.Equal(new DateTime(2026, 10, 24, 9, 15, 5, DateTimeKind.Utc), mail.ReceivedAt);
        Assert.Equal(DateTimeKind.Utc, mail.ReceivedAt.Kind);
        Assert.Equal(("Sales", "sales@example.test"), (mail.FromName, mail.FromAddress));
        Assert.Equal((byte)2, mail.Importance);
        Assert.Equal((byte)1, mail.FlagStatus);
        Assert.True(mail.HasAttachments);
        Assert.False(mail.IsRead);
        Assert.Equal("CONV1", mail.ConversationId);
        Assert.Equal("<abc@example.test>", mail.InternetMessageId);
        Assert.Equal(
            [
                new MailRecipientInfo(1, "Mona", "mona@example.test"),
                new MailRecipientInfo(1, "Ali", "ali@example.test"),
                new MailRecipientInfo(2, null, "cc@example.test"),
            ], mail.Recipients);
    }

    [Fact]
    public async Task A_bad_item_is_reported_without_failing_the_batch()
    {
        var client = Client("""
            <m:GetItemResponse><m:ResponseMessages>
              <m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>
                <m:Items><t:Message><t:ItemId Id="A1" ChangeKey="CK1" /><t:DateTimeReceived>2026-10-24T09:15:05Z</t:DateTimeReceived></t:Message></m:Items>
              </m:GetItemResponseMessage>
              <m:GetItemResponseMessage ResponseClass="Error">
                <m:MessageText>The specified object was not found in the store.</m:MessageText>
                <m:ResponseCode>ErrorItemNotFound</m:ResponseCode><m:Items />
              </m:GetItemResponseMessage>
            </m:ResponseMessages></m:GetItemResponse>
            """);
        var (items, failures) = await client.GetItemsAsync("mona@example.test", ["A1", "A2"], CancellationToken.None);
        Assert.Equal("A1", Assert.Single(items).ItemId);
        var failure = Assert.Single(failures);
        Assert.Equal(("A2", "ErrorItemNotFound"), (failure.ItemId, failure.Code));
    }

    [Fact]
    public async Task Only_mail_folders_are_marked_for_copy()
    {
        var client = Client("""
            <m:SyncFolderHierarchyResponse><m:ResponseMessages>
              <m:SyncFolderHierarchyResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>
                <m:SyncState>HS1</m:SyncState><m:IncludesLastFolderInRange>true</m:IncludesLastFolderInRange>
                <m:Changes>
                  <t:Create><t:Folder><t:FolderId Id="F1" ChangeKey="K1" /><t:ParentFolderId Id="ROOT" />
                    <t:FolderClass>IPF.Note</t:FolderClass><t:DisplayName>Inbox</t:DisplayName>
                    <t:TotalCount>10</t:TotalCount><t:UnreadCount>2</t:UnreadCount></t:Folder></t:Create>
                  <t:Create><t:CalendarFolder><t:FolderId Id="F2" /><t:FolderClass>IPF.Appointment</t:FolderClass>
                    <t:DisplayName>Calendar</t:DisplayName></t:CalendarFolder></t:Create>
                  <t:Create><t:Folder><t:FolderId Id="F3" /><t:FolderClass>IPF.Configuration</t:FolderClass>
                    <t:DisplayName>Settings</t:DisplayName></t:Folder></t:Create>
                  <t:Delete><t:FolderId Id="F4" /></t:Delete>
                </m:Changes>
              </m:SyncFolderHierarchyResponseMessage>
            </m:ResponseMessages></m:SyncFolderHierarchyResponse>
            """);
        var page = await client.SyncFolderHierarchyAsync("mona@example.test", null, CancellationToken.None);
        Assert.Equal("HS1", page.SyncState);
        Assert.True(page.IncludesLast);
        Assert.Equal(["F1"], page.Changes.Where(c => c.IsMail).Select(c => c.Id));
        Assert.Equal(new FolderChange(EwsChange.Create, "F1", "K1", "ROOT", "Inbox", 10, 2, true), page.Changes[0]);
        Assert.Equal(EwsChange.Delete, page.Changes[3].Change);
    }

    [Fact]
    public async Task Control_characters_from_mail_do_not_break_the_answer()
    {
        var client = Client("""
            <m:GetItemResponse><m:ResponseMessages>
              <m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>
                <m:Items><t:Message><t:ItemId Id="A1" ChangeKey="CK1" /><t:Subject>Report&#x1;&#x8; Q3</t:Subject>
                  <t:DateTimeReceived>2026-10-24T09:15:05Z</t:DateTimeReceived></t:Message></m:Items>
              </m:GetItemResponseMessage>
            </m:ResponseMessages></m:GetItemResponse>
            """);
        var (items, _) = await client.GetItemsAsync("mona@example.test", ["A1"], CancellationToken.None);
        Assert.Equal("Report\u0001\u0008 Q3", Assert.Single(items).Subject);
    }

    [Fact]
    public void An_expired_sync_state_is_its_own_kind() =>
        Assert.Equal(EwsErrorKind.InvalidSyncState, EwsClient.Classify("ErrorInvalidSyncStateData"));
}
