using Sila.MailConnector.Data;
using Sila.MailConnector.Publish;
using Xunit;

namespace Sila.MailConnector.Tests;

public sealed class PublishTests
{
    private static MailStore.ChangeRow C(long seq, string table, long id, char op) => new(seq, table, id.ToString(), op);

    private static MailStore.PublishRows Rows(params long[] messageIds)
    {
        var rows = new MailStore.PublishRows();
        foreach (var id in messageIds)
        {
            rows.Messages[id] = (id, 4, 7, $"ITEM{id}", "CK", "<x@y>", null, $"Subject {id}", "Sales", "s@example.test", null,
                new DateTime(2026, 10, 25, 7, 22, 38), false, 0, 1, false, false, null);
            rows.Recipients[id] = [(1, 0, "Mona", "m@example.test")];
        }
        return rows;
    }

    [Fact]
    public void The_last_change_of_a_row_wins()
    {
        var plan = BatchPlan.From([C(11, "MailMessage", 5, 'U'), C(12, "MailMessage", 5, 'D'), C(13, "MailMessage", 6, 'D'), C(14, "MailMessage", 6, 'U')]);
        Assert.Equal([6L], plan.MessageIds);   // 5 ends deleted, 6 ends written
        var batch = plan.Build(10, Rows(6));
        Assert.Equal(6, Assert.Single(batch.Messages).MessageId);
        Assert.Equal(14, batch.Messages[0].Seq);
        Assert.Equal(new Sila.Mail.Contract.KeySeq(5, 12), Assert.Single(batch.Deletes.Messages));
        Assert.Equal((10L, 14L), (batch.AfterSeq, batch.ToSeq));
    }

    [Fact]
    public void A_moved_message_is_one_delete_and_one_update()
    {
        // MergeMovesAsync: the new row 35020 goes, 18245 takes its Exchange ID
        var plan = BatchPlan.From([C(100, "MailMessage", 35020, 'D'), C(101, "MailMessage", 18245, 'U')]);
        var batch = plan.Build(99, Rows(18245));
        Assert.Equal(35020, Assert.Single(batch.Deletes.Messages).Id);
        Assert.Equal(18245, Assert.Single(batch.Messages).MessageId);
    }

    [Fact]
    public void A_row_gone_by_now_is_sent_as_a_delete()
    {
        // written, then removed (or marked deleted) before the publisher read it: not in the loaded rows
        var batch = BatchPlan.From([C(20, "MailMessage", 7, 'U'), C(21, "MailAttachment", 9, 'U')]).Build(19, Rows());
        Assert.Empty(batch.Messages);
        Assert.Equal(new Sila.Mail.Contract.KeySeq(7, 20), Assert.Single(batch.Deletes.Messages));
        Assert.Equal(new Sila.Mail.Contract.KeySeq(9, 21), Assert.Single(batch.Deletes.Attachments));
    }

    [Fact]
    public void A_message_travels_with_its_recipients_and_utc_dates()
    {
        var batch = BatchPlan.From([C(30, "MailMessage", 8, 'U')]).Build(29, Rows(8));
        var message = Assert.Single(batch.Messages);
        Assert.Equal("Mona", Assert.Single(message.Recipients).Name);
        Assert.Equal(DateTimeKind.Utc, message.ReceivedAt.Kind);
    }

    [Fact]
    public void Tables_not_copied_yet_only_move_the_sequence()
    {
        var batch = BatchPlan.From([C(40, "MailTicketLink", 1, 'U'), C(41, "MailAction", 2, 'U')]).Build(39, Rows());
        Assert.Equal((39L, 41L), (batch.AfterSeq, batch.ToSeq));
        Assert.Empty(batch.Messages);
        Assert.Empty(batch.Deletes.Messages);
    }
}
