import * as admin from 'firebase-admin';
import { logger } from 'firebase-functions';

export default class GithubEvents {
  /**
   * Attempts to remove the repos from the user document in Firestore
   * @param githubId The github id of the user
   * @param repoNames The full name of the repos
   * @returns True if operation was successful, false otherwise
   */
  async onRepoRemoved(githubId: number, repoNames: string[]) {
    try {
      // Find user by githubId
      const user = await this.findUserByGithubId(githubId);
      if (!user) {
        logger.warn('[onRepoRemoved] User not found', { githubId });
        return false;
      }

      // Remove repo from User document
      await admin
        .firestore()
        .collection('Users')
        .doc(user.id)
        .update({
          repos: admin.firestore.FieldValue.arrayRemove(...repoNames),
        });
      return true;
    } catch (e) {
      logger.error(
        '[onRepoRemoved] Failed to remove repo from user',
        { githubId },
        e,
      );
      return false;
    }
  }

  /**
   * Attempts to add the repos to the user document in Firestore
   * @param githubId The github id of the user
   * @param repoNames The full name of the repo
   * @returns True if operation was successful, false otherwise
   */
  async onRepoAdded(githubId: number, repoNames: string[]) {
    try {
      const user = await this.findUserByGithubId(githubId);
      if (!user) {
        logger.warn('[onRepoAdded] User not found', { githubId });
        return false;
      }

      const newTotal = user.repos.length + repoNames.length;
      if (newTotal > user.usage.repos_limit) {
        logger.warn('[onRepoAdded] User has reached repo limit', { githubId });
        return false;
      }

      // Add repo to User document
      await admin
        .firestore()
        .collection('Users')
        .doc(user.id)
        .update({
          repos: admin.firestore.FieldValue.arrayUnion(...repoNames),
        });
      return true;
    } catch (e) {
      logger.error('[onRepoAdded] Failed to add repo to user', { githubId }, e);
      return false;
    }
  }

  private async findUserByGithubId(githubId: number) {
    const query = await admin
      .firestore()
      .collection('Users')
      .where('githubId', '==', githubId)
      .get();

    if (query.empty) {
      return null;
    }
    const user = query.docs[0].data();
    return user;
  }
}
