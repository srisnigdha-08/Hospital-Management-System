'use strict';

function createNotificationControllerHandlers({
  Notification,
  ApiError,
  ApiResponse,
  asyncHandler,
  getPagination,
  buildMeta,
}) {
  const listMyNotifications = asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query, 15);
    const where = { userId: req.user.userId };
    if (req.query.unreadOnly === 'true') where.isRead = false;

    const { rows, count } = await Notification.findAndCountAll({
      where,
      limit,
      offset,
      order: [['notificationId', 'DESC']],
    });

    const unreadCount = await Notification.count({ where: { userId: req.user.userId, isRead: false } });
    new ApiResponse(200, rows, 'OK', { ...buildMeta({ page, limit, total: count }), unreadCount }).send(res);
  });

  const markAsRead = asyncHandler(async (req, res) => {
    const notification = await Notification.findOne({
      where: { notificationId: req.params.id, userId: req.user.userId },
    });
    if (!notification) throw ApiError.notFound('Notification not found');

    notification.isRead = true;
    await notification.save();
    new ApiResponse(200, notification).send(res);
  });

  const markAllAsRead = asyncHandler(async (req, res) => {
    await Notification.update({ isRead: true }, { where: { userId: req.user.userId, isRead: false } });
    new ApiResponse(200, null, 'All notifications marked as read').send(res);
  });

  return { listMyNotifications, markAsRead, markAllAsRead };
}

module.exports = { createNotificationControllerHandlers };
