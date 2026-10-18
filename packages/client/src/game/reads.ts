/**
 * The reads panel's logic moved to `@lms/protocol`, where the server's match
 * analyst uses it too; re-exported here under the name the client has always
 * used.
 */
export { readOpponents, type SeatRead as Read } from '@lms/protocol';
