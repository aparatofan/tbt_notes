<?php
/**
 * Admin (wp-admin) settings page for TBT Notes.
 *
 * Authoring happens in the front-end slide-out panel; this dashboard page is for
 * setup: choosing who can manage notes and toggling the floating launcher tab.
 *
 * The recommended way to let a teacher manage notes is to name their account(s)
 * directly (by username). That grants the capability to those specific users
 * without elevating everyone who shares their role (important when teachers and
 * students share a role on an LMS). Role-based granting is offered too, with a
 * warning.
 *
 * @package TBT_Notes
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class TBT_Notes_Admin
 */
class TBT_Notes_Admin {

	const PAGE_SLUG = 'tbt-notes';

	/**
	 * Hook admin menu.
	 */
	public function register() {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
	}

	/**
	 * Register the top-level menu page.
	 */
	public function add_menu() {
		add_menu_page(
			__( 'TBT Notes', 'tbt-notes' ),
			__( 'TBT Notes', 'tbt-notes' ),
			'manage_options',
			self::PAGE_SLUG,
			array( $this, 'render_page' ),
			'dashicons-welcome-write-blog',
			58
		);
	}

	/**
	 * Render (and handle saving of) the settings page.
	 */
	public function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'tbt-notes' ) );
		}

		$saved   = false;
		$unknown = array();
		if ( isset( $_POST['tbt_notes_nonce'] ) && wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['tbt_notes_nonce'] ) ), 'tbt_notes_save_settings' ) ) {
			$unknown = $this->save();
			$saved   = true;
		}

		$show_launcher    = get_option( 'tbt_notes_show_launcher', '1' ) !== '0';
		$manager_roles    = (array) get_option( 'tbt_notes_manager_roles', array( 'administrator' ) );
		$manager_user_ids = (array) get_option( 'tbt_notes_manager_users', array() );
		$all_roles        = wp_roles()->roles;

		// Build the current teacher-usernames string for the field.
		$teacher_logins = array();
		foreach ( $manager_user_ids as $uid ) {
			$u = get_userdata( (int) $uid );
			if ( $u ) {
				$teacher_logins[] = $u->user_login;
			}
		}
		?>
		<div class="wrap">
			<h1><?php echo esc_html__( 'TBT Notes', 'tbt-notes' ); ?></h1>

			<?php if ( $saved ) : ?>
				<div class="notice notice-success is-dismissible"><p><?php echo esc_html__( 'Settings saved.', 'tbt-notes' ); ?></p></div>
			<?php endif; ?>
			<?php if ( ! empty( $unknown ) ) : ?>
				<div class="notice notice-warning is-dismissible">
					<p>
						<?php
						echo esc_html(
							sprintf(
								/* translators: %s: comma-separated usernames. */
								__( 'These usernames were not found and were skipped: %s', 'tbt-notes' ),
								implode( ', ', $unknown )
							)
						);
						?>
					</p>
				</div>
			<?php endif; ?>

			<p><?php echo esc_html__( 'Teachers create and edit notes in the slide-out panel on the front-end of the site. Use this page to choose who can manage notes and how the panel is opened.', 'tbt-notes' ); ?></p>

			<form method="post" action="">
				<?php wp_nonce_field( 'tbt_notes_save_settings', 'tbt_notes_nonce' ); ?>

				<h2 class="title"><?php echo esc_html__( 'Teacher accounts', 'tbt-notes' ); ?></h2>
				<p class="description"><?php echo esc_html__( 'Recommended. Enter the username(s) of the teacher account(s) that can create classes and write notes — separated by commas or new lines. These users get access regardless of their role.', 'tbt-notes' ); ?></p>
				<table class="form-table" role="presentation">
					<tbody>
						<tr>
							<th scope="row"><label for="tbt_notes_manager_users"><?php echo esc_html__( 'Teacher usernames', 'tbt-notes' ); ?></label></th>
							<td>
								<textarea id="tbt_notes_manager_users" name="tbt_notes_manager_users" rows="2" class="large-text" placeholder="<?php echo esc_attr__( 'e.g. annateacher, mateusz', 'tbt-notes' ); ?>"><?php echo esc_textarea( implode( ', ', $teacher_logins ) ); ?></textarea>
							</td>
						</tr>
					</tbody>
				</table>

				<h2 class="title"><?php echo esc_html__( 'Roles that can manage (advanced)', 'tbt-notes' ); ?></h2>
				<p class="description"><?php echo esc_html__( 'Optional. Everyone in a ticked role can manage notes — avoid ticking a role that students also use. Administrators can always manage notes.', 'tbt-notes' ); ?></p>
				<table class="form-table" role="presentation">
					<tbody>
						<tr>
							<th scope="row"><?php echo esc_html__( 'Roles', 'tbt-notes' ); ?></th>
							<td>
								<?php foreach ( $all_roles as $slug => $role ) : ?>
									<?php
									$is_admin_role = ( 'administrator' === $slug );
									$checked       = $is_admin_role || in_array( $slug, $manager_roles, true );
									?>
									<label style="display:block;margin-bottom:6px;">
										<input type="checkbox" name="tbt_notes_manager_roles[]" value="<?php echo esc_attr( $slug ); ?>" <?php checked( $checked ); ?> <?php disabled( $is_admin_role ); ?> />
										<?php echo esc_html( translate_user_role( $role['name'] ) ); ?>
										<?php if ( $is_admin_role ) : ?>
											<em>(<?php echo esc_html__( 'always', 'tbt-notes' ); ?>)</em>
										<?php endif; ?>
									</label>
								<?php endforeach; ?>
							</td>
						</tr>
					</tbody>
				</table>

				<h2 class="title"><?php echo esc_html__( 'Opening the panel', 'tbt-notes' ); ?></h2>
				<table class="form-table" role="presentation">
					<tbody>
						<tr>
							<th scope="row"><?php echo esc_html__( 'Floating tab', 'tbt-notes' ); ?></th>
							<td>
								<label>
									<input type="checkbox" name="tbt_notes_show_launcher" value="1" <?php checked( $show_launcher ); ?> />
									<?php echo esc_html__( 'Show the floating "Notes" tab on the left edge of the site', 'tbt-notes' ); ?>
								</label>
								<p class="description">
									<?php echo esc_html__( 'Turn this off if you open Notes from your own menu instead.', 'tbt-notes' ); ?>
								</p>
							</td>
						</tr>
					</tbody>
				</table>

				<?php submit_button(); ?>
			</form>

			<hr />
			<h2 class="title"><?php echo esc_html__( 'Open Notes from your own menu', 'tbt-notes' ); ?></h2>
			<p><?php echo esc_html__( 'Any of these will open the Notes panel when clicked — use whichever your menu/page supports:', 'tbt-notes' ); ?></p>
			<ul style="list-style:disc;margin-left:20px;">
				<li><?php echo esc_html__( 'Shortcode (in a page, widget or block):', 'tbt-notes' ); ?> <code>[tbt_notes label="Notes"]</code></li>
				<li><?php echo esc_html__( 'A menu item / link pointing to:', 'tbt-notes' ); ?> <code>#tbt-notes</code></li>
				<li><?php echo esc_html__( 'Any element with the CSS class:', 'tbt-notes' ); ?> <code>tbt-notes-trigger</code></li>
			</ul>
			<p class="description"><?php echo esc_html__( 'For a WordPress menu, add a Custom Link with the URL #tbt-notes, or add the CSS class tbt-notes-trigger to a menu item (enable “CSS Classes” under Screen Options).', 'tbt-notes' ); ?></p>
		</div>
		<?php
	}

	/**
	 * Persist submitted settings.
	 *
	 * @return string[] Usernames that could not be resolved (for a warning).
	 */
	protected function save() {
		$show_launcher = isset( $_POST['tbt_notes_show_launcher'] ) ? '1' : '0';
		update_option( 'tbt_notes_show_launcher', $show_launcher );

		// Roles.
		$selected = isset( $_POST['tbt_notes_manager_roles'] )
			? array_map( 'sanitize_key', (array) wp_unslash( $_POST['tbt_notes_manager_roles'] ) )
			: array();
		if ( ! in_array( 'administrator', $selected, true ) ) {
			$selected[] = 'administrator';
		}
		update_option( 'tbt_notes_manager_roles', $selected );
		TBT_Notes_Capabilities::sync_role_caps( $selected );

		// Specific teacher accounts (by username/email).
		$raw     = isset( $_POST['tbt_notes_manager_users'] ) ? (string) wp_unslash( $_POST['tbt_notes_manager_users'] ) : '';
		$tokens  = preg_split( '/[\s,]+/', $raw, -1, PREG_SPLIT_NO_EMPTY );
		$new_ids = array();
		$unknown = array();
		foreach ( (array) $tokens as $token ) {
			$user = get_user_by( 'login', $token );
			if ( ! $user ) {
				$user = get_user_by( 'email', $token );
			}
			if ( $user ) {
				$new_ids[] = (int) $user->ID;
			} else {
				$unknown[] = sanitize_text_field( $token );
			}
		}
		$new_ids = array_values( array_unique( $new_ids ) );

		$old_ids = (array) get_option( 'tbt_notes_manager_users', array() );

		// Revoke from users no longer listed.
		foreach ( array_diff( $old_ids, $new_ids ) as $remove_id ) {
			$u = get_userdata( (int) $remove_id );
			if ( $u ) {
				$u->remove_cap( TBT_NOTES_CAP );
			}
		}
		// Grant to listed users.
		foreach ( $new_ids as $add_id ) {
			$u = get_userdata( $add_id );
			if ( $u ) {
				$u->add_cap( TBT_NOTES_CAP );
			}
		}
		update_option( 'tbt_notes_manager_users', $new_ids );

		return $unknown;
	}
}
