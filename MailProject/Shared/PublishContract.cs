namespace Sila.Mail.Contract;

// The publish batch: InternalMail -> the external Mail database (MailPlan 2.2, 7.2).
// The Mail Connector API (inside) sends it; the Mail External API (outside)
// applies it in one transaction. Shared by both projects (linked source file).
//
// - AfterSeq: the last change the sender knows the receiver applied. The
//   receiver refuses a batch whose AfterSeq is beyond its own LastAppliedSeq
//   (it would skip changes) and answers with its LastAppliedSeq.
// - ToSeq: the last MailChange sequence covered; the receiver's LastAppliedSeq
//   becomes max(LastAppliedSeq, ToSeq).
// - Every row and delete carries Seq, the MailChange sequence it comes from: a
//   row is only written, or deleted, when nothing newer is there already, so
//   the same batch applied twice changes nothing.
// - Rows are the CURRENT state at send time. A message carries its recipients.
// - Body HTML is gzip of the UTF-16 text (BodyHtmlGz), as stored inside.
public sealed record PublishBatch(
    long AfterSeq,
    long ToSeq,
    List<UserRow> Users,
    List<FolderRow> Folders,
    List<MessageRow> Messages,
    List<BodyRow> Bodies,
    List<AttachmentRow> Attachments,
    PublishDeletes Deletes);

public sealed record PublishDeletes(List<KeySeq> Users, List<KeySeq> Folders, List<KeySeq> Messages,
    List<KeySeq> Bodies, List<KeySeq> Attachments);

public sealed record KeySeq(long Id, long Seq);

public sealed record UserRow(int UserId, string SmtpAddress, string? DisplayName, bool IsEnabled, string SyncStatus,
    DateTime? LastSyncAt, DateTime? LastNotificationAt, int? ExchangeItemCount, int? ExchangeUnreadCount, long Seq);

public sealed record FolderRow(long FolderId, int UserId, long? ParentFolderId, string ExchangeFolderId, string DisplayName,
    string FolderType, int TotalCount, int UnreadCount, DateTime? LastSyncAt, long Seq);

public sealed record MessageRow(long MessageId, int UserId, long FolderId, string ExchangeItemId, string ChangeKey,
    string? InternetMessageId, string? ConversationId, string? Subject, string? FromName, string? FromAddress,
    DateTime? SentAt, DateTime ReceivedAt, bool IsRead, byte FlagStatus, byte Importance, bool HasAttachments,
    bool IsDraft, string? Preview, List<RecipientRow> Recipients, long Seq);

public sealed record RecipientRow(byte Type, short Position, string? Name, string? Address);

public sealed record BodyRow(long MessageId, byte[]? HtmlGz, string? Text, long Seq);

public sealed record AttachmentRow(long AttachmentId, long MessageId, string ExchangeAttachmentId, string Name,
    string? ContentType, long? Size, bool IsInline, string? ContentId, long Seq);

// The receiver's answer (and its answer to a refused batch: 409 with the same shape).
public sealed record PublishResult(long LastAppliedSeq, int Applied, int Skipped);
